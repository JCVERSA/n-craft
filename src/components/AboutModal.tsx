import { ArrowUpRight, Boxes, Code2, Github, Layers3, Sparkles } from 'lucide-react';
import { NebulaModal } from './NebulaModal.tsx';
import { NebulaBrandMark } from './NebulaBrandMark.tsx';

const PROJECT_REPOSITORY = 'https://github.com/JCVERSA/n-craft';
const UI_REFERENCE_REPOSITORY = 'https://github.com/JCVERSA/noto';

export function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <NebulaModal
      title="À propos de Nebula Craft"
      eyebrow="NEBULA CRAFT · CONTROL DECK"
      icon={Sparkles}
      tone="magma"
      size="wide"
      describedById="ncraft-about-description"
      initialFocus="close"
      onClose={onClose}
    >
      <div className="ncraft-about">
        <section className="ncraft-about-card" aria-labelledby="ncraft-about-product-name">
          <div className="ncraft-about-card__chrome" aria-hidden="true">
            <span className="ncraft-about-card__dot ncraft-about-card__dot--magma" />
            <span className="ncraft-about-card__dot ncraft-about-card__dot--portal" />
            <span className="ncraft-about-card__dot ncraft-about-card__dot--moss" />
            <span className="ncraft-about-card__chrome-label">BEDROCK CONTROL DECK</span>
          </div>

          <div className="ncraft-about-card__intro">
            <span className="ncraft-about-card__mark" aria-hidden="true"><NebulaBrandMark /></span>
            <div>
              <p className="nether-eyebrow">MONO-INSTANCE · LINUX</p>
              <h3 id="ncraft-about-product-name">Nebula Craft</h3>
              <p id="ncraft-about-description">
                Un panneau privé pour déployer et piloter Minecraft Bedrock Dedicated Server : mondes,
                console, diagnostics et tunnels, sans Docker imbriqué ni base de données.
              </p>
            </div>
          </div>

          <div className="ncraft-about-facts" aria-label="Informations sur l’application">
            <div className="ncraft-about-fact">
              <span><Layers3 size={14} /> Version du panneau</span>
              <strong>v{__APP_VERSION__}</strong>
            </div>
            <div className="ncraft-about-fact">
              <span><Boxes size={14} /> Compatibilité chatbot</span>
              <strong>BDS 1.21.130.3 · 1.21.130.4</strong>
            </div>
            <div className="ncraft-about-fact">
              <span><Code2 size={14} /> Conception</span>
              <strong>JCVERSA</strong>
            </div>
          </div>

          <div className="ncraft-about-links" aria-label="Liens du projet">
            <a href={PROJECT_REPOSITORY} target="_blank" rel="noreferrer">
              <Github size={16} aria-hidden="true" />
              <span><strong>Code source</strong><small>JCVERSA / n-craft</small></span>
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <a href={UI_REFERENCE_REPOSITORY} target="_blank" rel="noreferrer">
              <Sparkles size={16} aria-hidden="true" />
              <span><strong>Références visuelles</strong><small>Composants Noto, adaptés au thème Nether</small></span>
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </div>

          <p className="ncraft-about-credit">
            Les motifs de dialogue, de carte et de matrice s’inspirent des exemples publiés dans
            JCVERSA/noto; ils ont été retravaillés pour l’interface et les couleurs de Nebula Craft.
          </p>
        </section>
        <p className="ncraft-about-footnote">Minecraft Bedrock est un produit de Microsoft. Nebula Craft est un panneau indépendant.</p>
      </div>
    </NebulaModal>
  );
}
