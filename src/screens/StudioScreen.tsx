import { useState, useEffect, useRef, useCallback } from "react";
import {
  Sliders, Mic, Music, Bell, Gamepad2, Headphones, Mic2,
  Radio, StopCircle, Volume2, RefreshCw, ChevronDown,
  AlertTriangle, CheckCircle, LogOut,
} from "lucide-react";
import { Room, LocalAudioTrack } from "livekit-client";

interface Props {
  user: { name: string; image: string };
  onLogout: () => Promise<void>;
}

const TRACKS = [
  { id: "voice", label: "Microphone", icon: Mic, color: "from-pink-500 to-pink-600", border: "border-pink-500/40" },
  { id: "game", label: "Jeu", icon: Gamepad2, color: "from-blue-500 to-blue-600", border: "border-blue-500/40" },
  { id: "music", label: "Musique", icon: Music, color: "from-purple-500 to-purple-600", border: "border-purple-500/40" },
  { id: "alerts", label: "Alertes", icon: Bell, color: "from-yellow-500 to-orange-500", border: "border-yellow-500/40" },
  { id: "bonus1", label: "Discord / Voix 2", icon: Headphones, color: "from-teal-500 to-cyan-500", border: "border-teal-500/40" },
  { id: "bonus2", label: "Piste bonus", icon: Mic2, color: "from-green-500 to-emerald-500", border: "border-green-500/40" },
];

// Index OBS plugin (doit correspondre à TRACK_NAMES dans mixx-plugin.cpp)
const OBS_DEVICE_ID = "__obs_plugin__";
const OBS_TRACK_INDEX: Record<string, number> = {
  voice: 0, game: 1, music: 2, alerts: 3, bonus1: 4, bonus2: 5,
};

interface TrackState {
  deviceId: string;
  stream: MediaStream | null;
  active: boolean;
  level: number;
  error: string;
  obsWorklet?: AudioWorkletNode;
  obsDestination?: MediaStreamAudioDestinationNode;
}

export default function StudioScreen({ user, onLogout }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [tracks, setTracks] = useState<Record<string, TrackState>>(() =>
    Object.fromEntries(TRACKS.map((t) => [t.id, {
      deviceId: "",
      stream: null,
      active: false,
      level: 0,
      error: "",
    }]))
  );
  const [isLive, setIsLive] = useState(false);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [roomName, setRoomName] = useState("");
  const [showBonus, setShowBonus] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRefs = useRef<Record<string, number>>({});

  const visibleTracks = showBonus ? TRACKS : TRACKS.slice(0, 4);

  // ── Périphériques audio ──────────────────────────────────────────────────────

  const loadDevices = async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices(all.filter((d) => d.kind === "audioinput"));
  };

  const requestPermission = async () => {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      tmp.getTracks().forEach((t) => t.stop());
      setPermissionGranted(true);
      await loadDevices();
    } catch {
      setPermissionGranted(false);
    }
  };

  useEffect(() => {
    navigator.mediaDevices.addEventListener("devicechange", loadDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", loadDevices);
  }, []);

  // ── VU-mètre ─────────────────────────────────────────────────────────────────

  const startVu = useCallback((id: string, stream: MediaStream) => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      setTracks((prev) => ({ ...prev, [id]: { ...prev[id], level: Math.min(100, Math.round((avg / 128) * 100)) } }));
      analyserRefs.current[id] = requestAnimationFrame(tick);
    };
    analyserRefs.current[id] = requestAnimationFrame(tick);
  }, []);

  const stopVu = useCallback((id: string) => {
    if (analyserRefs.current[id]) cancelAnimationFrame(analyserRefs.current[id]);
    setTracks((prev) => ({ ...prev, [id]: { ...prev[id], level: 0 } }));
  }, []);

  // ── Capture ──────────────────────────────────────────────────────────────────

  const startObsCapture = useCallback(async (id: string) => {
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new AudioContext({ sampleRate: 48000 });
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") await ctx.resume();

      // En prod Electron, location.href = file:///…/dist/index.html
      // → new URL résout le chemin relatif correctement
      const workletUrl = new URL("./obs-audio-processor.js", location.href).href;
      await ctx.audioWorklet.addModule(workletUrl);
      const worklet = new AudioWorkletNode(ctx, "obs-audio-processor");
      const dest = ctx.createMediaStreamDestination();
      worklet.connect(dest);

      // VU-mètre sur la sortie worklet
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      worklet.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setTracks((prev) => ({ ...prev, [id]: { ...prev[id], level: Math.min(100, Math.round((avg / 128) * 100)) } }));
        analyserRefs.current[id] = requestAnimationFrame(tick);
      };
      analyserRefs.current[id] = requestAnimationFrame(tick);

      // Écoute les packets UDP du plugin OBS pour cette piste
      const obsIdx = OBS_TRACK_INDEX[id] ?? -1;
      window.mixx.onObsAudio(({ trackId, pcm }: { trackId: number; pcm: Buffer }) => {
        if (trackId !== obsIdx) return;
        // Copie dans un buffer aligné sur 4 octets (obligatoire pour Float32Array)
        const aligned = new Uint8Array(pcm).buffer;
        const float32 = new Float32Array(aligned);
        worklet.port.postMessage(float32.buffer, [float32.buffer]);
      });

      setTracks((prev) => ({
        ...prev,
        [id]: { ...prev[id], stream: dest.stream, active: true, error: "", obsWorklet: worklet, obsDestination: dest },
      }));
    } catch (err) {
      setTracks((prev) => ({ ...prev, [id]: { ...prev[id], error: "Erreur plugin OBS" } }));
      console.error(err);
    }
  }, []);

  const startCapture = useCallback(async (id: string, deviceId: string) => {
    if (deviceId === OBS_DEVICE_ID) {
      await startObsCapture(id);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      setTracks((prev) => ({ ...prev, [id]: { ...prev[id], stream, active: true, error: "" } }));
      startVu(id, stream);
    } catch {
      setTracks((prev) => ({ ...prev, [id]: { ...prev[id], error: "Accès refusé au périphérique" } }));
    }
  }, [startVu, startObsCapture]);

  const stopCapture = useCallback((id: string) => {
    stopVu(id);
    setTracks((prev) => {
      prev[id].stream?.getTracks().forEach((t) => t.stop());
      return { ...prev, [id]: { ...prev[id], stream: null, active: false, level: 0, error: "" } };
    });
  }, [stopVu]);

  const toggleCapture = useCallback(async (id: string) => {
    const t = tracks[id];
    if (t.active) stopCapture(id);
    else await startCapture(id, t.deviceId);
  }, [tracks, startCapture, stopCapture]);

  const selectDevice = useCallback(async (id: string, deviceId: string) => {
    setTracks((prev) => ({ ...prev, [id]: { ...prev[id], deviceId } }));
    if (tracks[id].active) {
      stopCapture(id);
      await startCapture(id, deviceId);
    }
  }, [tracks, stopCapture, startCapture]);

  // ── LiveKit ──────────────────────────────────────────────────────────────────

  const startLive = async () => {
    const active = visibleTracks.filter((t) => tracks[t.id].active);
    if (active.length === 0) return;
    setStatus("connecting");
    try {
      const { token, url, room } = await window.mixx.getLivekitToken();
      setRoomName(room);

      const lkRoom = new Room();
      roomRef.current = lkRoom;

      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") await ctx.resume();

      await lkRoom.connect(url, token);

      for (const t of active) {
        const stream = tracks[t.id].stream;
        if (!stream) continue;
        const audioTrack = stream.getAudioTracks()[0];
        if (!audioTrack) continue;
        const lkTrack = new LocalAudioTrack(audioTrack);
        await lkRoom.localParticipant.publishTrack(lkTrack, { name: t.id });
      }

      lkRoom.on("disconnected", () => {
        setIsLive(false);
        setStatus("error");
        roomRef.current = null;
      });

      setIsLive(true);
      setStatus("connected");
    } catch (err) {
      console.error(err);
      setStatus("error");
    }
  };

  const stopLive = () => {
    roomRef.current?.disconnect();
    roomRef.current = null;
    setIsLive(false);
    setStatus("idle");
    setRoomName("");
  };

  // Nettoyage
  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();
      Object.values(analyserRefs.current).forEach(cancelAnimationFrame);
      audioCtxRef.current?.close();
    };
  }, []);

  const deviceLabel = (d: MediaDeviceInfo, i: number) => d.label || `Périphérique ${i + 1}`;
  const activeTracks = visibleTracks.filter((t) => tracks[t.id].active);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-[#0f0f0f] text-white overflow-hidden">
      {/* Titlebar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-gradient-to-br from-pink-500 to-purple-600 rounded-lg flex items-center justify-center">
            <Sliders className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="font-bold text-sm bg-gradient-to-r from-pink-400 to-purple-400 bg-clip-text text-transparent">
            Mixx Studio
          </span>
        </div>

        <div className="flex items-center gap-3">
          {isLive && (
            <div className="flex items-center gap-1.5 bg-red-500/10 border border-red-500/30 text-red-400 text-xs px-2.5 py-1 rounded-lg">
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full pulse-dot" />
              EN DIRECT
            </div>
          )}
          {user.image && <img src={user.image} alt="" className="w-6 h-6 rounded-full" />}
          <span className="text-xs text-gray-400">{user.name}</span>
          <button onClick={onLogout} className="text-gray-600 hover:text-gray-300 transition-colors">
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Contenu */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* Étape 1 — Permission micro */}
        {!permissionGranted ? (
          <div className="bg-[#1a1a1a] border border-purple-500/30 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 bg-purple-500/10 rounded-xl flex items-center justify-center mx-auto mb-3">
              <Mic className="w-6 h-6 text-purple-400" />
            </div>
            <h2 className="font-semibold mb-2">Autoriser l&apos;accès aux périphériques audio</h2>
            <p className="text-gray-400 text-sm mb-4 max-w-sm mx-auto">
              Mixx Studio a besoin d&apos;accéder à tes périphériques pour lister les sources disponibles.
            </p>
            <button
              onClick={requestPermission}
              className="px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-medium transition-all"
            >
              Autoriser
            </button>
          </div>
        ) : (
          <>
            {/* Pistes audio */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-sm text-gray-200">Pistes audio</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowBonus((v) => !v)}
                    disabled={isLive}
                    className={`text-xs px-2 py-1 rounded-lg border transition-colors disabled:opacity-40 ${showBonus ? "bg-teal-500/20 border-teal-500/40 text-teal-300" : "border-white/10 text-gray-500 hover:text-white"}`}
                  >
                    {showBonus ? "6 pistes ✓" : "+ Pistes bonus"}
                  </button>
                  <button onClick={loadDevices} className="text-gray-500 hover:text-white transition-colors" title="Rafraîchir les périphériques">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {visibleTracks.map((track) => {
                  const state = tracks[track.id];
                  const Icon = track.icon;
                  return (
                    <div
                      key={track.id}
                      className={`bg-[#1a1a1a] border rounded-xl p-4 transition-all ${state.active ? `${track.border} bg-white/[0.02]` : "border-white/10"}`}
                    >
                      {/* Header */}
                      <div className="flex items-center gap-2.5 mb-3">
                        <div className={`w-8 h-8 bg-gradient-to-br ${track.color} rounded-lg flex items-center justify-center ${state.active ? "opacity-100" : "opacity-40"}`}>
                          <Icon className="w-4 h-4 text-white" />
                        </div>
                        <div className="flex-1">
                          <p className="font-medium text-xs">{track.label}</p>
                          {state.active && (
                            <div className="flex items-center gap-1 mt-0.5">
                              <span className="w-1 h-1 bg-green-400 rounded-full pulse-dot" />
                              <span className="text-[10px] text-green-400">Actif</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Sélecteur périphérique */}
                      <div className="relative mb-2">
                        <select
                          value={state.deviceId}
                          onChange={(e) => selectDevice(track.id, e.target.value)}
                          disabled={isLive}
                          className="w-full bg-[#2a2a2a] border border-white/10 text-gray-200 text-xs rounded-lg px-2.5 py-2 pr-7 appearance-none focus:outline-none focus:border-purple-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <option value="">— Périphérique —</option>
                          <option value={OBS_DEVICE_ID}>🎛️ Via Plugin OBS</option>
                          {devices.map((d, i) => (
                            <option key={d.deviceId} value={d.deviceId}>{deviceLabel(d, i)}</option>
                          ))}
                        </select>
                        <ChevronDown className="w-3 h-3 text-gray-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                      </div>

                      {/* VU-mètre */}
                      {state.active && (
                        <div className="mb-2">
                          <div className="flex items-center justify-between mb-1">
                            <Volume2 className="w-3 h-3 text-gray-600" />
                            <span className="text-[10px] text-gray-600">{state.level}%</span>
                          </div>
                          <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-75 ${state.level > 80 ? "bg-red-500" : state.level > 50 ? "bg-yellow-400" : "bg-green-400"}`}
                              style={{ width: `${state.level}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Erreur */}
                      {state.error && (
                        <div className="flex items-center gap-1 text-[10px] text-red-400 mb-2">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          {state.error}
                        </div>
                      )}

                      {/* Bouton activer */}
                      <button
                        onClick={() => toggleCapture(track.id)}
                        disabled={isLive || (!state.active && !state.deviceId)}
                        className={`w-full py-1.5 rounded-lg text-xs font-medium transition-all ${
                          state.active
                            ? "bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20"
                            : "bg-purple-600/20 text-purple-300 hover:bg-purple-600/30 border border-purple-500/20"
                        } disabled:opacity-30 disabled:cursor-not-allowed`}
                      >
                        {state.active ? "Désactiver" : "Activer"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Room info */}
            {roomName && (
              <div className="bg-[#1a1a1a] border border-white/10 rounded-xl px-4 py-2.5 flex items-center justify-between">
                <span className="text-xs text-gray-400">Room :</span>
                <span className="text-xs font-mono text-purple-300">{roomName}</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Bouton diffusion — fixé en bas */}
      {permissionGranted && (
        <div className="px-4 pb-4 pt-2 border-t border-white/5 shrink-0">
          {!isLive ? (
            <button
              onClick={startLive}
              disabled={activeTracks.length === 0 || status === "connecting"}
              className="w-full py-3 bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl font-semibold transition-all flex items-center justify-center gap-2"
            >
              {status === "connecting" ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Radio className="w-4 h-4" />
              )}
              {status === "connecting" ? "Connexion..." : `Démarrer la diffusion${activeTracks.length > 0 ? ` (${activeTracks.length} piste${activeTracks.length > 1 ? "s" : ""})` : ""}`}
            </button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/30 text-green-400 px-3 py-2 rounded-xl text-xs">
                <CheckCircle className="w-4 h-4 shrink-0" />
                En direct — {activeTracks.length} piste{activeTracks.length > 1 ? "s" : ""} actives
              </div>
              <button
                onClick={stopLive}
                className="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl font-semibold transition-all flex items-center justify-center gap-2 text-sm"
              >
                <StopCircle className="w-4 h-4" />
                Arrêter la diffusion
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
