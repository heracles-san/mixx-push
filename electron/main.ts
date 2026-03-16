import { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, session, dialog } from "electron";
import path from "path";
import dgram from "dgram";
import fs from "fs";
import { execSync } from "child_process";
import { autoUpdater } from "electron-updater";

const MIXX_OBS_PORT = 47891;

const MIXX_API = "https://mixx-app.vercel.app";

// app.isPackaged est false en dev (electron .) et true en production packagée
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function createWindow() {
  // Session persistante — les cookies (auth Twitch) sont sauvegardés sur disque
  // L'utilisateur reste connecté entre les lancements de l'app
  const persistentSession = session.fromPartition("persist:mixx");

  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 760,
    minHeight: 560,
    title: "Mixx Studio",
    backgroundColor: "#0f0f0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      session: persistentSession,
    },
    // Pas de frame native — on utilise notre propre titlebar
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
  });

  // Charge le renderer
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist-renderer/index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (e) => {
    // Minimise dans le tray au lieu de quitter
    e.preventDefault();
    mainWindow?.hide();
  });
}

function createTray() {
  // Icône simple (on utilisera une vraie icône en prod)
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Mixx Studio",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Ouvrir",
      click: () => mainWindow?.show(),
    },
    {
      label: "Ouvrir dans le navigateur",
      click: () => shell.openExternal(`${MIXX_API}/streamer`),
    },
    { type: "separator" },
    {
      label: "Quitter",
      click: () => {
        app.exit(0);
      },
    },
  ]);

  tray.setToolTip("Mixx Studio");
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => mainWindow?.show());
}

// ─── IPC : Authentification ───────────────────────────────────────────────────

// Vérifie si l'utilisateur est connecté en interrogeant notre API
ipcMain.handle("auth:check", async () => {
  try {
    const ses = mainWindow!.webContents.session;
    const cookies = await ses.cookies.get({ url: MIXX_API });
    const sessionCookie = cookies.find(
      (c) => c.name === "authjs.session-token" || c.name === "__Secure-authjs.session-token"
    );
    if (!sessionCookie) return null;

    // Vérifie que la session est valide
    const res = await fetch(`${MIXX_API}/api/auth/session`, {
      headers: { Cookie: `${sessionCookie.name}=${sessionCookie.value}` },
    });
    const data = await res.json();
    return data?.user ?? null;
  } catch {
    return null;
  }
});

// Ouvre une fenêtre de login Twitch
ipcMain.handle("auth:login", async () => {
  const authWindow = new BrowserWindow({
    width: 520,
    height: 680,
    title: "Connexion Twitch — Mixx",
    backgroundColor: "#0f0f0f",
    parent: mainWindow!,
    modal: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: session.fromPartition("persist:mixx"),
    },
  });

  // On charge la landing page — le bouton "Se connecter" y démarre le flux OAuth complet
  // avec le CSRF token géré automatiquement par NextAuth
  authWindow.loadURL(`${MIXX_API}/?source=electron`);

  // Injecte un clic automatique sur le bouton Twitch une fois la page chargée
  authWindow.webContents.on("did-finish-load", () => {
    authWindow.webContents.executeJavaScript(`
      // Cherche et clique le bouton Twitch après un court délai
      setTimeout(() => {
        const btn = document.querySelector('button[class*="twitch"], a[href*="twitch"], button');
        if (btn) btn.click();
      }, 800);
    `).catch(() => {});
  });

  return new Promise((resolve) => {
    // Connexion réussie = l'utilisateur arrive sur /subscribe, /mixer ou /streamer
    authWindow.webContents.on("did-navigate", (_, url) => {
      if (
        url.includes("/subscribe") ||
        url.includes("/mixer") ||
        url.includes("/streamer") ||
        url.includes("/become-streamer")
      ) {
        authWindow.close();
        resolve(true);
      }
    });
    authWindow.on("closed", () => resolve(false));
  });
});

// Déconnexion
ipcMain.handle("auth:logout", async () => {
  await session.fromPartition("persist:mixx").clearStorageData({ storages: ["cookies"] });
});

// ─── IPC : LiveKit token ──────────────────────────────────────────────────────

ipcMain.handle("livekit:token", async () => {
  try {
    const ses = mainWindow!.webContents.session;
    const cookies = await ses.cookies.get({ url: MIXX_API });
    const cookie = cookies
      .filter((c) => c.name === "authjs.session-token" || c.name === "__Secure-authjs.session-token")
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const res = await fetch(`${MIXX_API}/api/livekit/streamer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }

    return await res.json(); // { token, url, room }
  } catch (err) {
    throw err;
  }
});

// ─── Serveur UDP — reçoit l'audio du plugin OBS ───────────────────────────────

function startObsUdpServer() {
  const server = dgram.createSocket("udp4");

  server.on("message", (msg) => {
    if (!mainWindow || mainWindow.isDestroyed() || msg.length < 2) return;
    const trackId = msg[0]; // 0=Voix 1=Jeu 2=Musique 3=Alarmes
    const pcm = msg.slice(1); // PCM float32 little-endian
    mainWindow.webContents.send("obs:audio", { trackId, pcm });
  });

  server.bind(MIXX_OBS_PORT, "127.0.0.1", () => {
    console.log(`[Mixx] UDP OBS server écoute sur port ${MIXX_OBS_PORT}`);
  });

  server.on("error", (err) => {
    console.error("[Mixx] UDP error:", err.message);
    server.close();
  });
}

// ─── Auto-updater ────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  if (!app.isPackaged) return; // Désactivé en dev

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", () => {
    dialog.showMessageBox({
      type: "info",
      title: "Mise à jour disponible",
      message: "Une nouvelle version de Mixx Studio est disponible.",
      detail: "Le téléchargement démarre en arrière-plan. L'installation se fera automatiquement à la prochaine fermeture.",
      buttons: ["OK"],
    });
  });

  autoUpdater.on("update-downloaded", () => {
    dialog.showMessageBox({
      type: "info",
      title: "Mise à jour prête",
      message: "La mise à jour est téléchargée.",
      detail: "Redémarre Mixx Studio pour appliquer la mise à jour.",
      buttons: ["Redémarrer maintenant", "Plus tard"],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on("error", (err) => {
    console.error("[Mixx] Auto-updater error:", err.message);
  });

  // Vérifie les mises à jour au démarrage
  autoUpdater.checkForUpdates().catch(() => {});
}

// ─── Auto-install plugin OBS ──────────────────────────────────────────────────

async function installObsPlugin() {
  // Cherche le dossier plugins OBS (installation standard)
  const obsPluginDir = "C:\\Program Files\\obs-studio\\obs-plugins\\64bit";
  const destDll = path.join(obsPluginDir, "mixx-audio-router.dll");

  // La DLL est dans resources/ à côté de l'exe packagé
  const srcDll = app.isPackaged
    ? path.join(process.resourcesPath, "mixx-audio-router.dll")
    : path.join(__dirname, "../../resources/mixx-audio-router.dll");

  // OBS pas installé → on ne fait rien silencieusement
  if (!fs.existsSync(obsPluginDir)) return;

  // Plugin déjà installé → rien à faire
  if (fs.existsSync(destDll)) return;

  // Propose l'installation à l'utilisateur
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Plugin OBS Mixx",
    message: "Installer le plugin audio Mixx pour OBS ?",
    detail:
      "Ce plugin permet à OBS d'envoyer l'audio de chaque source directement dans Mixx Studio.\n\nUne fenêtre de confirmation Windows (UAC) va s'ouvrir.",
    buttons: ["Installer", "Plus tard"],
    defaultId: 0,
    cancelId: 1,
  });

  if (response !== 0) return;

  // Copie avec élévation via PowerShell RunAs
  const psCmd = `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -Command \\"Copy-Item -Path \\\\\"${srcDll.replace(/\\/g, "\\\\")}\\\\\" -Destination \\\\\"${destDll.replace(/\\/g, "\\\\")}\\\\\" -Force\\"' -Wait`;
  try {
    execSync(`powershell -NoProfile -Command "${psCmd}"`, { windowsHide: true });
    dialog.showMessageBox({
      type: "info",
      title: "Plugin OBS installé",
      message: "✅ Plugin Mixx Audio Router installé avec succès !",
      detail: "Redémarrez OBS puis ajoutez le filtre \"Mixx Audio Router\" sur vos sources audio.",
      buttons: ["OK"],
    });
  } catch (err) {
    console.error("[Mixx] Échec install plugin OBS:", err);
  }
}

// ─── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  createWindow();
  createTray();
  startObsUdpServer();
  setupAutoUpdater();
  mainWindow?.once("show", () => {
    setTimeout(() => installObsPlugin(), 2000);
  });
});

app.on("window-all-closed", () => {
  // Sur macOS, l'app reste active même sans fenêtre
  if (process.platform !== "darwin") tray?.destroy();
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
  else mainWindow.show();
});

// Autorise getUserMedia (micro) dans Electron
app.commandLine.appendSwitch("use-fake-ui-for-media-stream", "false");
