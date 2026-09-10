/**
 * Vérification vocale sur le compte réel — à lancer, pas à lire dans les logs du bot.
 *
 *   npm run voice:check            synthétise une phrase et l'envoie en vocal
 *   npm run voice:check -- --mute  synthétise seulement (rien n'est envoyé sur Telegram)
 *
 * Le but est de séparer deux pannes possibles que le bot mélange : « la clé ElevenLabs
 * est bonne » et « l'envoi Telegram marche ». Ici on sait lequel des deux a échoué.
 *
 * Écriture disque : aucune. Les octets vivent dans la mémoire du processus et y
 * meurent — c'est la propriété que l'invariant `media-no-residue` vérifie dans `src/`,
 * et ce script la respecte aussi.
 */
import { Bot, InputFile } from 'grammy';
import { loadConfig } from '../config.js';
import { buildSynthesizer } from '../audio/synthesize.js';

const PHRASE =
  "Test vocal d'OpenGravity. Ta clé ElevenLabs est bonne : je peux répondre à l'oral quand tu m'écris avec un message vocal. " +
  'La voix choisie est réglable à tout moment dans le fichier .env, et le mode de réponse se change avec la commande /voice.';

async function main(): Promise<void> {
  const config = loadConfig();
  const send = !process.argv.includes('--mute');

  const tts = buildSynthesizer(config);
  if (tts === null) {
    throw new Error(
      `pas de synthétiseur : elevenLabsApiKey=${config.elevenLabsApiKey === '' ? 'absente' : 'présente'}, ` +
        `elevenLabsVoiceId=${config.elevenLabsVoiceId === '' ? 'absente' : 'présente'}, mode=${config.voiceMode}`,
    );
  }

  const started = Date.now();
  const speech = await tts.synthesize(PHRASE);
  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  console.log(
    `✓ synthèse ElevenLabs : ${speech.bytes.byteLength} octets, ${speech.mime}, ` +
      `${speech.fileName}, ${seconds} s, coupée=${speech.truncated ? 'oui' : 'non'}`,
  );

  if (!send) {
    console.log('— mute : rien n’a été envoyé sur Telegram');
    return;
  }

  const chatId = [...config.allowedUserIds][0];
  if (chatId === undefined) throw new Error('aucun utilisateur autorisé : rien à qui envoyer le test');
  const bot = new Bot(config.telegramBotToken);
  const sent = await bot.api.sendMessage(chatId, `🔊 Test vocal (${speech.bytes.byteLength} octets, voix ${config.elevenLabsVoiceId}, ${seconds} s de synthèse).`);
  await bot.api.sendVoice(chatId, new InputFile(Buffer.from(speech.bytes), speech.fileName));
  bot.stop();
  console.log(`✓ envoyé dans le chat ${chatId} (message texte ${sent.message_id} + vocal juste après)`);
}

main().catch((error: unknown) => {
  // Le message d'erreur d'AudioError ne contient ni clé ni URL ; on n'affiche que ça.
  console.error(`✗ vérification vocale échouée : ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
