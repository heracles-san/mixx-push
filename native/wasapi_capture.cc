// wasapi_capture.cc — WASAPI Process Loopback pour Node.js (Windows 10 20H1+)
// Compile avec : npx electron-rebuild

#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>  // SDK 19041+ : structs process loopback
#include <audiopolicy.h>
#include <psapi.h>
#include <wrl/client.h>
#include <propvarutil.h>
#include <roapi.h>   // RoInitialize / RoUninitialize (WinRT)
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <map>
#include <mutex>

using Microsoft::WRL::ComPtr;

// ─── Completion handler pour ActivateAudioInterfaceAsync ─────────────────────

class ActivationHandler : public IActivateAudioInterfaceCompletionHandler {
  LONG          ref_    = 1;
  HANDLE        event_  = nullptr;
  IAudioClient* client_ = nullptr;
  HRESULT       result_ = E_PENDING;

public:
  ActivationHandler() : event_(CreateEvent(nullptr, FALSE, FALSE, nullptr)) {}
  ~ActivationHandler() { CloseHandle(event_); if (client_) client_->Release(); }

  HRESULT ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT hr; ComPtr<IUnknown> punk;
    op->GetActivateResult(&hr, &punk);
    result_ = hr;
    if (SUCCEEDED(hr)) punk->QueryInterface(__uuidof(IAudioClient), (void**)&client_);
    SetEvent(event_);
    return S_OK;
  }

  HRESULT QueryInterface(REFIID riid, void** ppv) override {
    if (riid == __uuidof(IActivateAudioInterfaceCompletionHandler) || riid == __uuidof(IUnknown)) {
      *ppv = this; AddRef(); return S_OK;
    }
    *ppv = nullptr; return E_NOINTERFACE;
  }
  ULONG AddRef()  override { return InterlockedIncrement(&ref_); }
  ULONG Release() override { LONG r = InterlockedDecrement(&ref_); if (!r) delete this; return r; }

  bool          Wait()      { return WaitForSingleObject(event_, 8000) == WAIT_OBJECT_0; }
  IAudioClient* TakeClient(){ auto c = client_; client_ = nullptr; return c; }
  HRESULT       GetResult() { return result_; }
};

// ─── État d'une capture active ────────────────────────────────────────────────

struct CaptureState {
  std::thread                thread;
  std::atomic<bool>          running{ true };
  Napi::ThreadSafeFunction   tsfn;
  DWORD                      pid;
};

static std::map<DWORD, CaptureState*> g_captures;
static std::mutex                      g_mu;

// ─── Lister les sessions audio actives ───────────────────────────────────────

Napi::Value ListSessions(const Napi::CallbackInfo& info) {
  auto env    = info.Env();
  auto result = Napi::Array::New(env);

  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  // Tout le travail WASAPI dans un bloc isolé — évite les goto / sauts sur init
  [&]() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&enumerator))) return;

    ComPtr<IMMDevice> device;
    if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device))) return;

    ComPtr<IAudioSessionManager2> mgr;
    if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr))) return;

    ComPtr<IAudioSessionEnumerator> senum;
    mgr->GetSessionEnumerator(&senum);

    int count = 0;
    senum->GetCount(&count);

    uint32_t idx = 0;
    for (int i = 0; i < count; i++) {
      ComPtr<IAudioSessionControl> ctrl;
      senum->GetSession(i, &ctrl);

      ComPtr<IAudioSessionControl2> ctrl2;
      ctrl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctrl2);
      if (!ctrl2) continue;

      DWORD pid = 0;
      ctrl2->GetProcessId(&pid);
      if (pid == 0) continue;

      HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
      if (!hProc) continue;

      WCHAR path[MAX_PATH] = {};
      DWORD sz = MAX_PATH;
      QueryFullProcessImageNameW(hProc, 0, path, &sz);
      CloseHandle(hProc);

      std::wstring wp(path);
      auto pos = wp.rfind(L'\\');
      std::wstring wname = (pos != std::wstring::npos) ? wp.substr(pos + 1) : wp;

      int n = WideCharToMultiByte(CP_UTF8, 0, wname.c_str(), -1, nullptr, 0, nullptr, nullptr);
      std::string name(n - 1, '\0');
      WideCharToMultiByte(CP_UTF8, 0, wname.c_str(), -1, &name[0], n, nullptr, nullptr);

      auto obj = Napi::Object::New(env);
      obj.Set("pid",  Napi::Number::New(env, static_cast<double>(pid)));
      obj.Set("name", Napi::String::New(env, name));
      result.Set(idx++, obj);
    }
  }();

  CoUninitialize();
  return result;
}

// ─── Thread de capture PCM ────────────────────────────────────────────────────

// Convertit HRESULT en chaîne hex lisible
static std::string HrStr(HRESULT hr) {
  char buf[20]; sprintf_s(buf, "0x%08X", (unsigned)hr); return buf;
}

// Envoie un message d'erreur texte au renderer (paquet marqué 0xFF)
static void SendError(CaptureState* state, std::string msg) {
  auto* pkt = new std::vector<uint8_t>(1 + msg.size());
  (*pkt)[0] = 0xFF;
  memcpy(pkt->data() + 1, msg.data(), msg.size());
  state->tsfn.NonBlockingCall(pkt, [](Napi::Env env, Napi::Function cb, std::vector<uint8_t>* p) {
    auto buf = Napi::Buffer<uint8_t>::Copy(env, p->data(), p->size());
    cb.Call({ buf }); delete p;
  });
  state->tsfn.Release();
}

// Capture tout l'audio système via WASAPI System Loopback (API classique, compatible Electron)
// ActivateAudioInterfaceAsync (process loopback WinRT) est incompatible avec le runtime Node.js/Electron
void CaptureThread(CaptureState* state) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  // Périphérique de sortie par défaut
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (FAILED(hr)) { SendError(state, "DeviceEnumerator: " + HrStr(hr)); CoUninitialize(); return; }

  ComPtr<IMMDevice> device;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (FAILED(hr)) { SendError(state, "GetDefaultEndpoint: " + HrStr(hr)); CoUninitialize(); return; }

  ComPtr<IAudioClient> client;
  hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
  if (FAILED(hr)) { SendError(state, "Activate: " + HrStr(hr)); CoUninitialize(); return; }

  WAVEFORMATEX* fmt = nullptr;
  client->GetMixFormat(&fmt);

  UINT32 sampleRate = fmt->nSamplesPerSec;
  UINT16 channels   = static_cast<UINT16>(fmt->nChannels);
  UINT16 bits       = fmt->wBitsPerSample;

  // AUDCLNT_STREAMFLAGS_LOOPBACK = capture de la sortie audio (tout le système)
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                          200 * 10000LL, 0, fmt, nullptr);
  CoTaskMemFree(fmt);
  if (FAILED(hr)) { SendError(state, "Initialize: " + HrStr(hr)); CoUninitialize(); return; }

  ComPtr<IAudioCaptureClient> capture;
  hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
  if (FAILED(hr)) { SendError(state, "GetService: " + HrStr(hr)); CoUninitialize(); return; }

  client->Start();

  while (state->running.load()) {
    // Polling toutes les 10 ms
    Sleep(10);

    UINT32 packetLength = 0;
    if (FAILED(capture->GetNextPacketSize(&packetLength)) || packetLength == 0) continue;

    BYTE*  data   = nullptr;
    UINT32 frames = 0;
    DWORD  flags  = 0;

    while (SUCCEEDED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr)) && frames > 0) {
      // Paquet : [sampleRate(4)][channels(2)][bits(2)][pcm...]
      size_t pcmSize = static_cast<size_t>(frames) * channels * (bits / 8);
      size_t total   = 8 + pcmSize;

      auto* pkt = new std::vector<uint8_t>(total);
      memcpy(pkt->data() + 0, &sampleRate, 4);
      memcpy(pkt->data() + 4, &channels,   2);
      memcpy(pkt->data() + 6, &bits,       2);
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data)
        memcpy(pkt->data() + 8, data, pcmSize);

      state->tsfn.NonBlockingCall(pkt, [](Napi::Env env, Napi::Function cb, std::vector<uint8_t>* p) {
        auto buf = Napi::Buffer<uint8_t>::Copy(env, p->data(), p->size());
        cb.Call({ buf });
        delete p;
      });

      capture->ReleaseBuffer(frames);
    }
  }

  client->Stop();
  state->tsfn.Release();
  CoUninitialize();
}

// ─── Démarrer la capture d'un process ────────────────────────────────────────

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
  auto  env = info.Env();
  DWORD pid = static_cast<DWORD>(info[0].As<Napi::Number>().Uint32Value());
  auto  cb  = info[1].As<Napi::Function>();

  std::lock_guard<std::mutex> lock(g_mu);
  if (g_captures.count(pid)) {
    Napi::Error::New(env, "Ce PID est déjà en cours de capture").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto* state  = new CaptureState();
  state->pid   = pid;
  state->tsfn  = Napi::ThreadSafeFunction::New(env, cb, "wasapi_pcm", 0, 1);
  state->thread = std::thread(CaptureThread, state);

  g_captures[pid] = state;
  return env.Undefined();
}

// ─── Arrêter la capture ───────────────────────────────────────────────────────

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
  DWORD pid = static_cast<DWORD>(info[0].As<Napi::Number>().Uint32Value());

  std::lock_guard<std::mutex> lock(g_mu);
  auto it = g_captures.find(pid);
  if (it != g_captures.end()) {
    it->second->running.store(false);
    if (it->second->thread.joinable()) it->second->thread.join();
    delete it->second;
    g_captures.erase(it);
  }
  return info.Env().Undefined();
}

// ─── Export ───────────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("listSessions", Napi::Function::New(env, ListSessions));
  exports.Set("startCapture", Napi::Function::New(env, StartCapture));
  exports.Set("stopCapture",  Napi::Function::New(env, StopCapture));
  return exports;
}

NODE_API_MODULE(wasapi_capture, Init)
