# SSE — pense-bête temps réel

Référence pour **éviter les bugs de synchro temps réel** (état périmé, message qui n'arrive pas, bulle qui disparaît, besoin de refresh). Tirée des incidents réels — chaque piège ci-dessous correspond à un bug qu'on a déjà eu en prod.

> Règle mentale : **un client ne voit JAMAIS un changement d'état tant qu'un event SSE ne le lui dit pas** (ou qu'il ne refetch pas). Si tu modifies de l'état que quelqu'un regarde, demande-toi toujours « qui d'autre doit le voir, et comment l'apprend-il ? ».

---

## 1. Le modèle en 30 secondes

- **Une seule connexion SSE par client** (`EventSource` sur `/api/sse`), multiplexée par `agentId`. Pas de connexion par-Agent.
- **Émission serveur** via `sseManager` (`src/server/sse/index.ts`) :
  | Méthode | Portée | Quand l'utiliser |
  |---|---|---|
  | `sendToAgent(agentId, ev)` | **TOUS** les clients connectés (ne filtre PAS côté serveur) | événement lié à un Agent (chat, queue, tasks…) — le **front filtre par `agentId`** |
  | `sendToUser(userId, ev)` | toutes les connexions de cet utilisateur | événement perso (notifications, read-state, profil, comptes) |
  | `broadcast(ev)` | tous les clients | global, non scopé à un Agent/user (custom-tools, toolboxes, providers globaux…) |
- **Forme du fil** : `formatSSE` aplatit en `{ type, agentId, ...data }`. Donc `data: dto` ⇒ les champs du DTO sont au **top-level** du payload reçu côté client (pas sous `data.xxx`).
- **Réception client** : `useSSE({ 'event': (data) => … })`. Statut : `useSSEStatus()`. Rattrapage : `useSSEResync(cb)` (`src/client/hooks/useSSE.ts`).
- **⚠️ SSE ne rejoue PAS les events manqués.** Onglet en arrière-plan / téléphone verrouillé / déconnexion = events perdus → il **faut refetch** au retour.
- Catalogue des events : `src/server/sse/types.ts` (`SSEEventType`). Contrats payload : `api.md`.

---

## 2. Les 3 règles d'or

1. **Tu mutes de l'état visible → tu émets un event.** Tout `create/update/delete/changement de statut` qu'un autre client ou un autre appareil doit voir en direct DOIT émettre (sinon : périmé jusqu'au refresh).
2. **Tout event émis a un handler.** Ajouter un `type` dans l'union sans handler client = event mort. Ajouter un handler sans émetteur = code mort. Les deux côtés ou rien.
3. **Tout hook piloté par SSE rattrape au réveil.** S'il tient de l'état mis à jour par events, il appelle `useSSEResync(refetch)` — sinon il reste figé après un réveil mobile / reconnexion.

---

## 3. Checklist « quand j'ajoute… »

### …un nouvel event SSE
- [ ] Ajouter le `type` à l'union `SSEEventType` dans `src/server/sse/types.ts` (**jamais** de cast `as SSEEventType` — ça contourne la sécurité de type et planque un event non déclaré).
- [ ] Choisir la portée : `sendToAgent` (lié Agent) / `sendToUser` (perso) / `broadcast` (global).
- [ ] Documenter le payload dans `api.md` (section SSE).
- [ ] Écrire le **handler client** dans le(s) hook(s) concerné(s).
- [ ] Vérifier que les champs émis = champs lus côté client (cf. piège #2).

### …une mutation serveur (route POST/PUT/PATCH/DELETE ou service)
- [ ] Après la persistance, émettre l'event correspondant **avant** de renvoyer la réponse.
- [ ] Émettre la **vraie** valeur d'état, pas une constante (cf. piège #3).
- [ ] Sérialiser les DTO (`serializeFile`, `toXxxDTO`) — **ne jamais** envoyer une ligne DB brute (cf. piège #2).

### …un hook client piloté par SSE
- [ ] `useSSE({...})` pour les events live.
- [ ] **`useSSEResync(refetch)`** pour le rattrapage au réveil/reconnexion.
- [ ] Dans chaque handler : filtrer par `agentId` si applicable, dédupliquer par id, **merger** (ne pas écraser des champs absents de l'event).

---

## 4. Les 8 pièges récurrents (chacun = un vrai bug qu'on a eu)

| # | Piège | Exemple réel | Le bon réflexe |
|---|---|---|---|
| 1 | **MISSING_EMIT** — on mute sans émettre | message user mis en file mais jamais diffusé → invisible sur les autres appareils | toute mutation visible émet un event |
| 2 | **PAYLOAD_SHAPE_MISMATCH** — le serveur envoie une forme ≠ de ce que le client lit, ou le client hardcode/jette un champ | `chat:message` envoyait des lignes DB brutes (sans `url`) **et** le handler faisait `files: []` | sérialiser côté serveur ; mapper `data.xxx` côté client (jamais `[]`/`null` en dur) |
| 3 | **WRONG_HARDCODED_DATA** — payload avec une valeur figée qui écrase l'état | `enqueueMessage` émettait `isProcessing: false` en plein turn → la bulle de réflexion disparaissait | calculer la vraie valeur (`isAgentProcessing()`), pas une constante |
| 4 | **CATCHUP_GAP** — pas de refetch au réveil | hooks figés après déverrouillage du téléphone (SSE ne rejoue rien) | `useSSEResync(refetch)` sur le hook |
| 5 | **EVENT_COVERAGE** — émis sans handler / handler sans émetteur | `knowledge:source-*` émis, aucun consommateur (event mort) | câbler les deux côtés, ou supprimer l'event |
| 6 | **KINID_OR_DEDUP** — pas de filtre `agentId`, pas de dédup, pas de réconciliation optimiste | doublon bulle optimiste + bulle réelle | filtrer par `agentId` ; dédup par id ; réconcilier l'optimiste via un token (`mergeIncomingMessage` + `clientMessageId`) |
| 7 | **STATE_CLOBBER_ON_PARTIAL** — le handler écrase des champs absents de l'event | un event « fin de traitement » sans `processingStartedAt` effaçait le timer | **merger** (`?? existing.xxx`), n'écraser que les champs présents |
| 8 | **MULTI_DEVICE** — update optimiste local jamais diffusé | action visible seulement sur l'appareil émetteur | diffuser côté serveur ; l'émetteur réconcilie son optimiste (dédup par id) |

---

## 5. Réconciliation optimiste (le cas chat)

Quand le client affiche un état optimiste **avant** la confirmation serveur, et que le serveur **rediffuse** ce même état à tous (multi-appareils) :

- Le client génère un **token de réconciliation** (`clientMessageId`), l'utilise comme id optimiste, et l'envoie dans le POST.
- Le serveur **ré-émet ce token** dans l'event.
- Le handler utilise `mergeIncomingMessage(prev, msg, token)` (`src/client/lib/reconcile-messages.ts`) :
  1. déjà présent par id → no-op (dédup) ;
  2. token correspond à une bulle optimiste à nous → on la **remplace** ;
  3. sinon → on **ajoute** (autre appareil / autre membre).
- ⚠️ La PK serveur ≠ l'id renvoyé par certains endpoints (ex. `enqueueMessage` renvoie l'id du *queue item*, pas la PK du message) → c'est **pourquoi** il faut un token séparé, pas l'id retourné.

---

## 6. Checklist de revue (PR touchant état partagé / SSE)

- [ ] Chaque mutation visible émet un event ? (sinon refresh requis → bug)
- [ ] Bonne portée (`sendToAgent` / `sendToUser` / `broadcast`) ?
- [ ] Payload émis == champs lus côté client ? DTO sérialisés (pas de ligne DB brute) ?
- [ ] Aucune valeur figée (`false`, `[]`, `null`) là où une vraie valeur est attendue ?
- [ ] Handler client : filtre `agentId`, dédup par id, merge (pas d'écrasement partiel) ?
- [ ] Le hook a `useSSEResync` si son état dépend d'events ?
- [ ] `type` ajouté à `SSEEventType` (pas de cast `as SSEEventType`) + documenté dans `api.md` ?

---

## 7. Gotcha des tests

`mock.module` de Bun remplace un module **globalement pour tout le run** `bun test` (pas d'isolation par fichier). Donc **ne jamais** écrire un test qui importe le vrai module qu'un autre test mocke globalement (ex. `@/server/services/queue` est mocké par `tasks-global-queue.test.ts`). **Préférer des tests de helpers purs** (ex. `mergeIncomingMessage` dans `reconcile-messages.test.ts`) qui n'ont aucune dépendance globale.
