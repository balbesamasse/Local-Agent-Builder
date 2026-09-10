#!/usr/bin/env node
/**
 * Double du CLI `gws`, pour les tests du transport.
 *
 * Choix de conception, dicté par une leçon déjà consignée dans ce dépôt : un double de test doit
 * lire EXACTEMENT les mêmes champs que le client. Le faux STT temps réel lisait `audio_base64`
 * là où le client envoyait `audio_base_64`, et trois rustines de latence ont été appliquées au
 * mauvais fichier avant qu'on pense à imprimer la trame reçue. Ici, le double est donc appelé
 * COMME LE VRAI BINAIRE (spawn, argv, `--params` JSON, code de sortie, stdout nu), et il
 * enregistre ce qu'il a reçu pour que le test statue sur la construction réelle de l'appel.
 *
 * Les formes de réponses ci-dessous sont relevées sur la 0.22.5 installée : `--version`,
 * l'enveloppe `{"error":{"code":401,"reason":"authError"}}`, le `auth status` authentifié à
 * `none` avec code de sortie 0, et la divergence helper/méthode sur les erreurs.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const MODE = process.env['FAKE_GWS_MODE'] ?? 'fixtures';
const RECORD = process.env['FAKE_GWS_RECORD'];
const FIXTURES = process.env['FAKE_GWS_FIXTURES'];

function record(entry) {
  if (RECORD === undefined || RECORD === '') return;
  appendFileSync(RECORD, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** `--flag valeur` / `--flag` (booléen), à la manière du CLI réel. */
function parse(rest) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (typeof token !== 'string') continue;
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags[name] = true;
      else {
        flags[name] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function paramsOf(flags) {
  if (typeof flags['params'] !== 'string') return {};
  try {
    return JSON.parse(flags['params']);
  } catch (error) {
    // C'est exactement le symptome du double muet : un JSON mal construit par le client doit
    // faire echouer le test, pas lui laisser croire que la requete etait vide.
    fail(3, `paramsFlag illisible : ${String(error.message)}`, 'validationError');
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code, message, reason) {
  print({ error: { code, message, reason } });
  process.stderr.write(`error[${reason === 'authError' ? 'auth' : 'api'}]: ${message}\n`);
  process.exit(code === 0 ? 1 : code);
}

function keyFor(positional) {
  // Les helpers commencent par '+' (eventuellement apres le service : `gws gmail +send`).
  const helper = positional.find((token) => token.startsWith('+'));
  if (helper !== undefined) return `helper ${helper}`;
  // Une methode REST est `service resource [sous-resource] methode` : la cle, c'est la sequence
  // entiere. Tronquer d'un cran (comme je l'avais fait) donnait « gmail messages list » pour un
  // client qui demande « gmail users messages list » — et le double repondait « inconnu ».
  return positional.join(' ');
}

const FIXTURE = {
  'auth status': {
    auth_method: 'oauth',
    credential_source: 'encrypted_store',
    storage: 'encrypted',
    keyring_backend: 'file',
    client_config: '/home/fake/.config/gws/client_secret.json',
    client_config_exists: true,
    encrypted_credentials: '/home/fake/.config/gws/credentials.enc',
    encrypted_credentials_exists: true,
    plain_credentials: '/home/fake/.config/gws/credentials.json',
    plain_credentials_exists: false,
    token_cache_exists: true,
  },
  'gmail users messages list': {
    messages: [
      { id: '18f0abcd_ef-1', threadId: '18f0abcd_thread' },
      { id: '18f0abcd_ef-2', threadId: '18f0abcd_other' },
    ],
    resultSizeEstimate: 2,
  },
  'gmail users messages get': {
    id: '18f0abcd_ef-1',
    threadId: '18f0abcd_thread',
    snippet: 'Bonjour, la facture de septembre est en piece jointe.',
    labelIds: ['UNREAD', 'INBOX'],
    internalDate: String(Date.now() - 3600_000),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'Comptable <comptable@exemple.fr>' },
        { name: 'To', value: 'moi@gmail.com' },
        { name: 'Subject', value: 'Facture septembre' },
        { name: 'Date', value: 'Wed, 03 Sep 2026 07:00:00 +0000' },
      ],
      parts: [
        {
          mimeType: 'text/plain',
          body: { size: 68, data: Buffer.from('Bonjour, la facture de septembre est en pièce jointe. Cordialement.', 'utf8').toString('base64url') },
        },
        {
          mimeType: 'text/html',
          body: { size: 40, data: Buffer.from('<p>Bonjour</p>', 'utf8').toString('base64url') },
        },
      ],
    },
  },
  'drive files list': {
    files: [
      { id: '1DrVtextFileId0001', name: 'notes-de-reunion.txt', mimeType: 'text/plain', modifiedTime: '2026-08-30T09:12:00.000Z' },
      { id: '1DrVdocFileId00002', name: 'Stratégie Q4', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-08-28T18:00:00.000Z' },
    ],
    nextPageToken: 'TOKEN_PAGE_2',
  },
  'drive files get': 'Ligne 1 du fichier texte\nLigne 2 avec un token qui ne doit pas fuiter: ya29.a0AVvZSgSecretMaterial123456\n',
  'drive files get (metadata)': { id: '1DrVtextFileId0001', name: 'notes-de-reunion.txt', mimeType: 'text/plain', modifiedTime: '2026-08-30T09:12:00.000Z' },
  'docs documents get': {
    title: 'Stratégie Q4',
    body: {
      content: [
        { endOfSegmentLocation: {}, id: 'start' },
        { paragraph: { elements: [{ textRun: { content: 'Stratégie Q4' }, paragraph: { elements: [] } }] }, id: 'p1' },
        { paragraph: { elements: [{ textRun: { content: 'Objectif : tenir la marge.' } }] }, id: 'p2' },
        {
          table: {
            tableRows: [
              { tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'région' } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: 'marge' } }] } }] }] },
              { tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'EMOA' } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: '18 %' } }] } }] }] },
            ],
          },
          id: 't1',
        },
      ],
    },
  },
  'sheets spreadsheets values get': {
    range: "Feuille1!A1:C3",
    majorDimension: 'COLUMNS',
    values: [['mois', 'ventes', 'marge'], ['août', '1200', '17 %'], ['septembre', '', '']],
  },
  'calendar events list': {
    items: [
      {
        id: 'evt-next-01',
        summary: 'Point fournisseur',
        status: 'confirmed',
        location: 'Visio',
        organizer: { email: 'moi@gmail.com', displayName: 'Moi' },
        start: { dateTime: '2026-09-03T14:30:00+00:00' },
        end: { dateTime: '2026-09-03T15:00:00+00:00' },
      },
      { id: 'evt-cancel', summary: 'Réunion annulée', status: 'cancelled', start: { date: '2026-09-04' }, end: { date: '2026-09-05' } },
    ],
  },
  'helper +send': { id: 'sent-18f0', labelIds: ['SENT'] },
  'helper +insert': { id: 'evt-created', summary: 'Rendez-vous', htmlLink: 'https://calendar.google.com/event?eid=abc', start: { dateTime: '2026-09-04T09:00:00+00:00' } },
  'helper +append': { spreadsheetId: 'SH1', updates: { updatedRows: '1', updatedRange: 'Feuille1!A4:C4' } },
  'helper +write': { writeControl: {} },
  'drive files delete': null,
};

function fixturesOverride() {
  if (FIXTURES === undefined || FIXTURES === '') return {};
  try {
    return JSON.parse(readFileSync(FIXTURES, 'utf8'));
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ modes

async function main() {
  // ------------------------------------------------------------------ modes

  const { positional, flags } = parse(argv);
  const recordEntry = { argv, env: Object.keys(process.env).sort(), params: typeof flags['params'] === 'string' ? flags['params'] : undefined, dryRun: flags['dry-run'] === true };

  // `--version` est un FLAG pour le parseur, pas une position : le CLI reel le traite comme une
  // sous-commande. Sans ce test en priorite, le double repondrait « aucun fixture » a la sonde de
  // disponibilite du transport, et tous les outils diraient « client absent ».
  if (argv.includes('--version') || argv.includes('version')) {
    process.stdout.write('gws 0.0.0-fake\nThis is not an officially supported Google product.\n');
    process.exit(0); // la sonde de disponibilite n'est pas un appel Google : elle n'est pas tracee
  }
  if (MODE === 'hang') {
    // Le module ne doit PAS se poursuivre : un setInterval seul laisse Node finir le module,
    // et un top-level await eternel le fait sortir en ERR_UNFINISHED_TOP_LEVEL_AWAIT (code 13).
    // D'ou `return` dans une fonction, pas dans le corps du module.
    setInterval(() => undefined, 1000);
    return;
    // Un appel qui pend ne doit pas pendre l'agent : le test vérifie que le fils est tue.
    try {
      if (process.env['FAKE_GWS_PIDFILE']) writeFileSync(process.env['FAKE_GWS_PIDFILE'], String(process.pid));
    } catch {
      /* le test qui ne reclame pas de pidfile n'a pas besoin qu'on echoue pour lui en ecrire un */
    }
  } else record(recordEntry);
  if (MODE === 'huge') {
    process.stdout.write('x'.repeat(Number(process.env['FAKE_GWS_HUGE_BYTES'] ?? 2_000_000)));
    process.exit(0);
  } else if (MODE === 'raw') {
    if (process.env['FAKE_GWS_STDOUT'] !== undefined) process.stdout.write(process.env['FAKE_GWS_STDOUT']);
    process.exit(Number(process.env['FAKE_GWS_EXIT'] ?? 0));
  } else if (MODE === 'mcp') {
    // Forme reelle observee sur la 0.22.5 quand on demande le serveur MCP retire du CLI.
    fail(1, "Unknown service 'mcp'. Known services: drive, sheets, gmail, calendar.", 'validationError');
  } else if (MODE === 'authfail') {
    // Methode REST : code HTTP dans l'enveloppe, sortie 2.
    fail(2, 'Authentication failed: credentials missing or invalid', 'authError');
  } else if (MODE === 'authfail-helper') {
    // Helper : code 0 dans l'enveloppe, vrai 401 noye dans une chaine echapee, sortie 1.
    print({
      error: {
        code: 0,
        message:
          '{\n  "error": {\n    "code": 401,\n    "message": "Request had invalid authentication credentials.",\n    "errors": [ { "message": "Invalid Credentials", "reason": "authError" } ]\n  }\n}\n',
        reason: 'calendarList_failed',
      },
    });
    process.exit(1);
  } else if (MODE === 'quota') {
    fail(1, 'User rate limit exceeded (429)', 'rateLimitExceeded');
  } else if (MODE === 'notfound') {
    fail(1, 'Not Found: file does not exist', 'notFound');
  } else if (MODE === 'forbidden') {
    fail(1, 'Google Drive API has not been used in project 123 or it is disabled.', 'accessNotConfigured');
  } else if (MODE === 'garbage') {
    process.stdout.write('warning: mise a jour disponible\n' + 'x'.repeat(20));
    process.exit(0);
  }

  if (flags['dry-run'] === true) {
    // Le CLI reel construit la requete et la rend sans appeler Google : le double rend la meme
    // chose, pour que le test porte sur la construction et pas sur une interpretation maison.
    print({ dry_run: true, method: positional[1] === '+send' ? 'POST' : 'GET', url: `https://fake.googleapis.com/${positional.join('/')}`, query_params: Object.entries(paramsOf(flags)).map(([k, v]) => [k, String(v)]), body: flags['json'] ?? null });
    process.exit(0);
  }

  let key = keyFor(positional);
  // `drive files get` rend le CONTENU avec alt=media et les METADONNEES sans : le double qui
  // confondrait les deux ferait passer un bug de verification de nom pour un succes.
  if (key === 'drive files get') {
    const p = paramsOf(flags);
    if (p['alt'] !== 'media') key = 'drive files get (metadata)';
  }
  const override = fixturesOverride();
  const value = key in override ? override[key] : FIXTURE[key];
  if (value === undefined) {
    fail(3, `aucun fixture pour « ${key} » — le client demande un appel que le double ne connaît pas`, 'validationError');
  }
  print(value);
  process.exit(0);

}

main();
