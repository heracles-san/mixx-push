import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mixx", {
  // Auth
  checkAuth: () => ipcRenderer.invoke("auth:check"),
  login:     () => ipcRenderer.invoke("auth:login"),
  logout:    () => ipcRenderer.invoke("auth:logout"),

  // LiveKit
  getLivekitToken: () => ipcRenderer.invoke("livekit:token"),

  // Plugin OBS — reçoit les chunks PCM par piste
  onObsAudio: (cb: (data: { trackId: number; pcm: Buffer }) => void) => {
    ipcRenderer.on("obs:audio", (_event, data) => cb(data));
  },
  offObsAudio: () => {
    ipcRenderer.removeAllListeners("obs:audio");
  },
});

export {};
