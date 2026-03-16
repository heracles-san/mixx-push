// wasapi-helper.cpp — Helper standalone pour WASAPI Process Loopback
// Usage : wasapi-helper.exe <PID>   (0 = loopback système)
// Protocole stdout : paquets binaires [uint32 longueur][uint32 sampleRate][uint16 channels][uint16 bits][pcm...]
//
// Exigences Microsoft (sample officiel ApplicationLoopback) :
//   - RoInitialize(RO_INIT_MULTITHREADED)  →  initialise WinRT + COM (CoInitializeEx seul = insuffisant)
//   - FtmBase sur le handler              →  callback dispatché sur worker thread sans deadlock

#include <windows.h>
#include <roapi.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstring>
#include <atomic>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;

static std::atomic<bool> g_running{ true };

BOOL WINAPI CtrlHandler(DWORD signal) {
  if (signal == CTRL_C_EVENT || signal == CTRL_BREAK_EVENT || signal == CTRL_CLOSE_EVENT) {
    g_running.store(false);
    return TRUE;
  }
  return FALSE;
}

// ─── Completion handler (identique au sample Microsoft ApplicationLoopback) ──
// FtmBase = free-threaded marshaling : le callback peut être appelé depuis
// n'importe quel thread (worker thread) sans marshaling cross-apartment.

class ActivationHandler :
  public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                      IActivateAudioInterfaceCompletionHandler>
{
  HANDLE        event_  = nullptr;
  IAudioClient* client_ = nullptr;
  HRESULT       result_ = E_PENDING;
public:
  ActivationHandler() : event_(CreateEvent(nullptr, FALSE, FALSE, nullptr)) {}
  ~ActivationHandler() { CloseHandle(event_); if (client_) client_->Release(); }

  HRESULT STDMETHODCALLTYPE ActivateCompleted(
      IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT hr;
    ComPtr<IUnknown> punk;
    op->GetActivateResult(&hr, &punk);
    result_ = hr;
    if (SUCCEEDED(hr))
      punk->QueryInterface(__uuidof(IAudioClient), (void**)&client_);
    SetEvent(event_);
    return S_OK;
  }

  bool          Wait()       { return WaitForSingleObject(event_, 10000) == WAIT_OBJECT_0; }
  IAudioClient* TakeClient() { auto c = client_; client_ = nullptr; return c; }
  HRESULT       GetResult()  { return result_; }
};

// ─── Envoi PCM sur stdout ────────────────────────────────────────────────────

static std::vector<char> g_silence;

void WritePacket(UINT32 sampleRate, UINT16 channels, UINT16 bits,
                 BYTE* data, UINT32 frames, DWORD flags) {
  size_t   pcmSize     = (size_t)frames * channels * (bits / 8);
  uint32_t payloadSize = (uint32_t)(8 + pcmSize);

  fwrite(&payloadSize, 4, 1, stdout);
  fwrite(&sampleRate,  4, 1, stdout);
  fwrite(&channels,    2, 1, stdout);
  fwrite(&bits,        2, 1, stdout);

  if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data) {
    fwrite(data, 1, pcmSize, stdout);
  } else {
    if (g_silence.size() < pcmSize) g_silence.assign(pcmSize, 0);
    fwrite(g_silence.data(), 1, pcmSize, stdout);
  }
  fflush(stdout);
}

// ─── Main ────────────────────────────────────────────────────────────────────

int main(int argc, char* argv[]) {
  _setmode(_fileno(stdout), _O_BINARY);
  SetConsoleCtrlHandler(CtrlHandler, TRUE);

  DWORD targetPid = (argc >= 2) ? (DWORD)atoi(argv[1]) : 0;

  // WinRT MTA — nécessaire pour ActivateAudioInterfaceAsync (VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK)
  // CoInitializeEx seul n'initialise pas WinRT, provoquant E_ILLEGAL_STATE_CHANGE.
  HRESULT roHr = RoInitialize(RO_INIT_MULTITHREADED);
  fprintf(stderr, "[helper] RoInitialize: 0x%08X\n", (unsigned)roHr);
  fflush(stderr);
  if (FAILED(roHr) && roHr != S_FALSE) {
    // S_FALSE = déjà initialisé, OK
    fprintf(stderr, "[helper] RoInitialize failed, abort\n");
    fflush(stderr);
    return 1;
  }

  ComPtr<IAudioClient> client;
  bool useLoopbackFlag = false;

  // ── Tentative Process Loopback (si PID > 0) ──────────────────────────────
  if (targetPid > 0) {
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId    = targetPid;
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT propvar = {};
    propvar.vt             = VT_BLOB;
    propvar.blob.cbSize    = sizeof(params);
    propvar.blob.pBlobData = (BYTE*)&params;

    ComPtr<ActivationHandler> handler = Make<ActivationHandler>();
    ComPtr<IActivateAudioInterfaceAsyncOperation> op;

    HRESULT hr = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
      __uuidof(IAudioClient),
      &propvar,
      handler.Get(),
      &op
    );

    fprintf(stderr, "[helper] ActivateAudioInterfaceAsync: 0x%08X\n", (unsigned)hr);
    fflush(stderr);

    if (SUCCEEDED(hr)) {
      if (!handler->Wait()) {
        fprintf(stderr, "[helper] Timeout\n");
        fflush(stderr);
      } else if (FAILED(handler->GetResult())) {
        fprintf(stderr, "[helper] ActivateCompleted failed: 0x%08X\n",
                (unsigned)handler->GetResult());
        fflush(stderr);
      } else {
        client = ComPtr<IAudioClient>(handler->TakeClient());
        fprintf(stderr, "[helper] Process loopback OK for PID %lu\n", targetPid);
        fflush(stderr);
      }
    }
  }

  // ── Fallback : System Loopback ────────────────────────────────────────────
  if (!client) {
    fprintf(stderr, "[helper] Fallback system loopback\n");
    fflush(stderr);
    ComPtr<IMMDeviceEnumerator> enumerator;
    CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                     __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    ComPtr<IMMDevice> device;
    enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
    useLoopbackFlag = true;
  }

  if (!client) { RoUninitialize(); return 1; }

  // Le virtual device process loopback ne supporte pas GetMixFormat (E_NOTIMPL).
  // On récupère le format depuis le périphérique de sortie par défaut.
  WAVEFORMATEX* fmt = nullptr;
  {
    ComPtr<IMMDeviceEnumerator> enumerator;
    CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                     __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    ComPtr<IMMDevice> device;
    enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    ComPtr<IAudioClient> tmpClient;
    device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&tmpClient);
    tmpClient->GetMixFormat(&fmt);
  }
  fprintf(stderr, "[helper] fmt=%p\n", (void*)fmt);
  fflush(stderr);
  if (!fmt) { RoUninitialize(); return 1; }

  UINT32 sampleRate = fmt->nSamplesPerSec;
  UINT16 channels   = (UINT16)fmt->nChannels;
  UINT16 bits       = fmt->wBitsPerSample;
  fprintf(stderr, "[helper] Format: %uHz %uch %ubits\n", sampleRate, (unsigned)channels, (unsigned)bits);
  fflush(stderr);

  // AUDCLNT_STREAMFLAGS_LOOPBACK est requis aussi bien pour le system loopback
  // que pour le process loopback (le virtual device est traité comme render endpoint).
  DWORD initFlags = AUDCLNT_STREAMFLAGS_LOOPBACK;
  HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, initFlags,
                                   200 * 10000LL, 0, fmt, nullptr);
  CoTaskMemFree(fmt);
  fprintf(stderr, "[helper] Initialize: 0x%08X\n", (unsigned)hr);
  fflush(stderr);

  if (FAILED(hr)) {
    RoUninitialize();
    return 1;
  }

  ComPtr<IAudioCaptureClient> capture;
  HRESULT svcHr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
  fprintf(stderr, "[helper] GetService: 0x%08X capture=%p\n", (unsigned)svcHr, (void*)capture.Get());
  fflush(stderr);
  if (FAILED(svcHr) || !capture) { RoUninitialize(); return 1; }

  HRESULT startHr = client->Start();
  fprintf(stderr, "[helper] Start: 0x%08X\n", (unsigned)startHr);
  fflush(stderr);
  if (FAILED(startHr)) { RoUninitialize(); return 1; }

  fprintf(stderr, "[helper] Capture started — sampleRate=%u channels=%u bits=%u\n",
          sampleRate, (unsigned)channels, (unsigned)bits);
  fflush(stderr);

  int totalPackets = 0, silentPackets = 0;

  while (g_running.load()) {
    Sleep(10);

    UINT32 packetLength = 0;
    if (FAILED(capture->GetNextPacketSize(&packetLength)) || packetLength == 0) continue;

    BYTE*  data   = nullptr;
    UINT32 frames = 0;
    DWORD  flags  = 0;

    while (SUCCEEDED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))
           && frames > 0) {
      WritePacket(sampleRate, channels, bits, data, frames, flags);
      capture->ReleaseBuffer(frames);
      totalPackets++;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) silentPackets++;
      // Log toutes les 10 000 paquets (environ toutes les 100 s)
      if (totalPackets % 10000 == 0) {
        fprintf(stderr, "[helper] Packets: %d total, %d silent (%.0f%%)\n",
                totalPackets, silentPackets,
                100.0 * silentPackets / totalPackets);
        fflush(stderr);
      }
    }
  }

  client->Stop();
  RoUninitialize();
  return 0;
}
