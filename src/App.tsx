import { useState, useEffect } from "react";
import AuthScreen from "./screens/AuthScreen";
import StudioScreen from "./screens/StudioScreen";

// Typage de l'API Electron exposée via preload
declare global {
  interface Window {
    mixx: {
      checkAuth: () => Promise<{ name: string; image: string } | null>;
      login: () => Promise<boolean>;
      logout: () => Promise<void>;
      getLivekitToken: () => Promise<{ token: string; url: string; room: string }>;
    };
  }
}

export default function App() {
  const [user, setUser] = useState<{ name: string; image: string } | null>(null);
  const [checking, setChecking] = useState(true);

  const checkAuth = async () => {
    setChecking(true);
    try {
      const u = await window.mixx.checkAuth();
      setUser(u);
    } catch {
      setUser(null);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  const handleLogin = async () => {
    const success = await window.mixx.login();
    if (success) await checkAuth();
  };

  const handleLogout = async () => {
    await window.mixx.logout();
    setUser(null);
  };

  if (checking) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0f0f0f]">
        <div className="w-8 h-8 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <AuthScreen onLogin={handleLogin} />;
  }

  return <StudioScreen user={user} onLogout={handleLogout} />;
}
