import type { FormEvent } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, ArrowRight, Eye, EyeOff, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { NebulaBrandMark } from '../../components/NebulaBrandMark.tsx';
import { NetherAmbientBackground } from '../../components/NetherAmbientBackground.tsx';
import type { AuthStatus } from '../../types/backend.ts';

export interface PanelLoginViewProps {
  authStatus: AuthStatus | null;
  reduceMotion: boolean;
  loginUsername: string;
  onUsernameChange: (value: string) => void;
  token: string;
  onTokenChange: (value: string) => void;
  showToken: boolean;
  onToggleShowToken: () => void;
  loginBusy: boolean;
  loginError: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function PanelLoginView({
  authStatus,
  reduceMotion,
  loginUsername,
  onUsernameChange,
  token,
  onTokenChange,
  showToken,
  onToggleShowToken,
  loginBusy,
  loginError,
  onSubmit,
}: PanelLoginViewProps) {
  return (
    <main className="ncraft-shell ncraft-auth-shell">
      <NetherAmbientBackground />
      <div className="ncraft-auth-orbit" aria-hidden="true" />
      <motion.div
        className="ncraft-login-layout"
        initial={reduceMotion ? false : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] }}
      >
        <aside className="ncraft-login-showcase">
          <div className="login-showcase__texture" aria-hidden="true" />
          <div className="login-showcase__brand" aria-hidden="true">
            <span className="brand-mark"><NebulaBrandMark /></span>
            <span>BEDROCK CONTROL DECK</span>
          </div>
          <div className="login-showcase__portal" aria-hidden="true"><span /><span /><span /></div>
          <img
            className="login-showcase__mascot"
            src="/assets/minecraft/creeper-mascot.svg"
            alt="Creeper pixelisé, mascotte de N-Craft"
            width="140"
            height="204"
          />
          <div className="login-showcase__content">
            <p className="login-showcase__eyebrow">CONSOLE OPÉRATEUR · MINECRAFT BEDROCK</p>
            <p className="login-showcase__title">Garde la main<br /><span>sur ton monde.</span></p>
            <p className="login-showcase__description">Déploie Bedrock, retrouve tes sauvegardes et surveille ton serveur depuis un seul panneau privé.</p>
          </div>
          <div className="login-showcase__footer" aria-hidden="true">
            <span><LockKeyhole size={14} /> Accès privé</span>
            <span><ShieldCheck size={14} /> Jeton non conservé</span>
          </div>
        </aside>

        <motion.section
          className="ncraft-login-card"
          initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: reduceMotion ? 0 : 0.3, delay: reduceMotion ? 0 : 0.06, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="login-brand-row">
            <span className="brand-mark brand-mark--large"><NebulaBrandMark /></span>
            <div>
              <p className="nether-eyebrow">BEDROCK CONTROL DECK</p>
              <h1 className="login-wordmark" translate="no">Nebula Craft</h1>
              <p className="login-subtitle">Panneau privé · instance Bedrock</p>
            </div>
          </div>
          <div className="login-divider" />
          <div className="login-heading">
            <span className="login-heading__icon"><LockKeyhole size={18} /></span>
            <div>
              <h2>Accès opérateur</h2>
              <p>Connecte-toi pour gérer ton serveur.</p>
            </div>
          </div>
          <p className="login-security-copy">
            Utilise un compte de rôle ou laisse le nom vide pour te connecter avec PANEL_TOKEN. Le secret n’est pas conservé dans le navigateur.
          </p>
          {!authStatus?.configured && (
            <div role="alert" className="nether-callout nether-callout--danger">
              <AlertTriangle size={17} />
              <span>PANEL_TOKEN n’est pas configuré dans l’environnement du conteneur. Définis-le, puis redémarre le panneau.</span>
            </div>
          )}
          <form onSubmit={onSubmit} className="login-form">
            <div className="nether-field">
              <label className="login-token-label" htmlFor="panel-username">Nom du compte <span>(laisser vide pour PANEL_TOKEN)</span></label>
              <input
                id="panel-username"
                type="text"
                autoComplete="username"
                value={loginUsername}
                onChange={(event) => onUsernameChange(event.target.value)}
                disabled={!authStatus?.configured || loginBusy}
                className="nether-input"
                placeholder="owner"
                maxLength={32}
              />
            </div>
            <div className="nether-field">
              <label className="login-token-label" htmlFor="panel-token">{loginUsername.trim() ? 'Mot de passe du compte' : 'Jeton du panneau'}</label>
              <div className="login-token-field">
                <input
                  id="panel-token"
                  type={showToken ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={token}
                  onChange={(event) => onTokenChange(event.target.value)}
                  disabled={!authStatus?.configured || loginBusy}
                  className="nether-input login-token-input"
                  placeholder={loginUsername.trim() ? 'Saisis le mot de passe du compte' : 'Saisis le jeton propriétaire'}
                  aria-invalid={Boolean(loginError)}
                  aria-describedby={loginError ? 'login-error' : undefined}
                />
                <button
                  type="button"
                  className="login-token-toggle"
                  onClick={onToggleShowToken}
                  disabled={!authStatus?.configured || loginBusy}
                  aria-label={showToken ? 'Masquer le secret de connexion' : 'Afficher le secret de connexion'}
                  aria-pressed={showToken}
                  title={showToken ? 'Masquer le secret de connexion' : 'Afficher le secret de connexion'}
                >
                  {showToken ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>
            {loginError && <p id="login-error" role="alert" className="inline-error">{loginError}</p>}
            <motion.button
              type="submit"
              disabled={!authStatus?.configured || loginBusy || !token}
              whileTap={reduceMotion ? undefined : { scale: 0.985 }}
              className="nether-btn nether-btn--primary nether-btn--wide"
            >
              {loginBusy ? <Loader2 className="spin-soft" size={17} /> : <ArrowRight size={17} />}
              {loginBusy ? 'Vérification…' : 'Ouvrir le panneau'}
            </motion.button>
          </form>
          <p className="login-footer"><ShieldCheck size={14} /> Session HttpOnly · secret non conservé</p>
        </motion.section>
      </motion.div>
    </main>
  );
}
