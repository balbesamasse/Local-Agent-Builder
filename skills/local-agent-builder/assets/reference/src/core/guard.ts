/**
 * Garde-fous de survie : ce qui empêche une erreur isolée de tuer le processus.
 *
 * Trois règles, toutes nées d'un arrêt réel du bot :
 *
 * 1. **une promesse rejetée sans `catch` ne doit pas être mortelle.** Node 20 considère
 *    un `unhandledRejection` comme fatal par défaut ; dans un bot qui tourne des jours
 *    durant, un `.catch()` oublié sur un appel de journalisation tuerait le service pour
 *    rien. On journalise et on continue.
 * 2. **une exception synchrone non attrapée doit être expliquée avant de mourir**, et
 *    mourir *vite* : on ne sait pas dans quel état le processus se trouve. C'est le
 *    superviseur qui le relance — pas un `catch` qui ferait sembl.
 * 3. **le code de sortie est une interface.** `78` = configuration invalide (relancer ne
 *    sert à rien, un humain doit lire le message) ; `75` = panne temporaire (relancer).
 *    Sans cette distinction, un superviseur either tourne en boucle sur une config
 *    cassée, soit laisse le bot mort après un incident réseau.
 */
import { log } from './logger.js';

/** Arrêt propre : rien à redémarrer, on a été arrêté exprès. */
export const EX_OK = 0;
/** Panne temporaire (réseau, fournisseur, bug passager) : à relancer. */
export const EX_TEMPFAIL = 75;
/** Problème de configuration : relancer produirait la même panne, instant par instant. */
export const EX_CONFIG = 78;

export interface CrashGuardOptions {
  /**
   * Nettoyage avant sortie (fermer le polling, compacter la base). L'appel ne doit pas
   * rejeter : toute erreur y est journalisée puis ignorée, sinon la garde devient la panne.
   */
  onFatal?: (error: unknown) => void | Promise<void>;
  /** Injection pour les tests ; `process.exit` par défaut. */
  exit?: (code: number) => void;
}

export interface CrashGuards {
  /** Nombre de rejets survécus — utile pour un `/stats` ou un test. */
  rejections(): number;
  /** Retire les écouteurs (tests uniquement). */
  dispose(): void;
}

/**
 * Erreur irrécupérable par relance. Le test se fait par NOM et non par `instanceof` :
 * la garde doit rester utilisable depuis le superviseur ou un test sans tirer avec elle
 * tout le graphe de la configuration.
 */
export function isConfigError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'ConfigError' || error.name === 'FatalError');
}

/** Le code de sortie que mérite une erreur de démarrage. */
export function exitCodeFor(error: unknown, isPermanent: (error: unknown) => boolean = isConfigError): number {
  return isPermanent(error) ? EX_CONFIG : EX_TEMPFAIL;
}

export function installCrashGuards(options: CrashGuardOptions = {}): CrashGuards {
  let rejections = 0;
  let fatalInProgress = false;
  const exit = options.exit ?? ((code: number): never => process.exit(code));

  const onRejection = (reason: unknown): void => {
    rejections += 1;
    log.error('promesse rejetée sans gestion — survécu', {
      raison: reason instanceof Error ? reason.message.slice(0, 200) : String(reason).slice(0, 200),
      cumul: rejections,
    });
    // Pas d'exit : le traitement en cours des autres conversations n'a rien demandé.
  };

  const onException = (error: Error): void => {
    // La trame d'abord, sur stdout ET dans le fichier : après l'exit, il n'y aura plus
    // personne pour la demander.
    log.fatal('exception non attrapée — arrêt pour redémarrage', {
      erreur: error.message.slice(0, 200),
      trame: (error.stack ?? '').split('\n').slice(1, 4).join(' | ').slice(0, 300),
    });
    if (fatalInProgress) {
      // Une seconde exception pendant la fermeture : on coupe sans discuter.
      exit(EX_TEMPFAIL);
      return;
    }
    fatalInProgress = true;
    void (async () => {
      try {
        await options.onFatal?.(error);
      } catch (cleanupError) {
        log.error('la fermeture d’urgence a elle-même échoué', {
          raison: cleanupError instanceof Error ? cleanupError.message.slice(0, 160) : 'erreur inconnue',
        });
      } finally {
        exit(EX_TEMPFAIL);
      }
    })();
  };

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  return {
    rejections: () => rejections,
    dispose: () => {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
    },
  };
}
