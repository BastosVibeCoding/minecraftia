import type { Bot } from 'mineflayer';

/** Caractères retirés en tête de message : espaces, barres obliques et contre-obliques. */
const LEADING = /^[\s\/\\]+/;

/**
 * Un message de chat qui commence par « / » est exécuté comme commande serveur avec les droits du bot.
 * Tout texte sortant (réponses de commandes, phrases du LLM) est donc neutralisé : jamais de « / »
 * en tête, pas de retour à la ligne, longueur bornée.
 */
export function sanitizeChat(text: string, max = 250): string {
  return text.replace(/[\r\n]+/g, ' ').replace(LEADING, '').slice(0, max);
}

/** Remplace `bot.chat` par une version sûre, pour tous les appelants (compétences, commandes, retours). */
export function installSafeChat(bot: Bot): void {
  const raw = bot.chat.bind(bot);
  bot.chat = (message: string) => {
    const safe = sanitizeChat(message);
    if (safe) raw(safe);
  };
}
