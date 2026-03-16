import { useState } from "react";
import { Sliders } from "lucide-react";

interface Props {
  onLogin: () => Promise<void>;
}

export default function AuthScreen({ onLogin }: Props) {
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    try {
      await onLogin();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-[#0f0f0f] gap-8">
      {/* Logo */}
      <div className="flex flex-col items-center gap-3">
        <div className="w-16 h-16 bg-gradient-to-br from-pink-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-xl shadow-purple-900/50">
          <Sliders className="w-8 h-8 text-white" />
        </div>
        <div className="text-center">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-pink-400 to-purple-400 bg-clip-text text-transparent">
            Mixx Studio
          </h1>
          <p className="text-gray-500 text-sm mt-1">App de diffusion audio streamer</p>
        </div>
      </div>

      {/* Card connexion */}
      <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-8 w-80 flex flex-col gap-5">
        <div className="text-center">
          <h2 className="font-semibold text-white mb-1">Connexion requise</h2>
          <p className="text-gray-400 text-sm">
            Connecte-toi avec ton compte Twitch pour accéder au studio.
          </p>
        </div>

        <button
          onClick={handleLogin}
          disabled={loading}
          className="w-full py-3 bg-[#9147ff] hover:bg-[#772ce8] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-semibold transition-all flex items-center justify-center gap-3"
        >
          {loading ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            /* Twitch icon SVG */
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" />
            </svg>
          )}
          {loading ? "Connexion en cours..." : "Se connecter avec Twitch"}
        </button>
      </div>

      <p className="text-gray-600 text-xs">
        Une fenêtre va s&apos;ouvrir pour te connecter à Mixx.
      </p>
    </div>
  );
}
