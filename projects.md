# Hivekeep — Projets et tickets

Système de gestion de projets avec tickets organisés en kanban. Permet à n'importe quel Agent de la plateforme de travailler sur n'importe quel projet, en lui injectant le contexte du projet actif dans son prompt et en lui exposant des outils CRUD dédiés.

> Ce document décrit la feature complète : modèle de données, outils Agent, API REST, prompt, navigation. Voir `CLAUDE.md` pour le contexte global de Hivekeep et `schema.md` pour les conventions générales de schéma.

---

## 1. Concepts et principes

### Projet

Un projet est une **entité de premier ordre** dans Hivekeep, indépendante des Agents. Il regroupe une description (contexte donné aux Agents qui travaillent dessus), une liste de tickets, et une bibliothèque de tags propre au projet.

Un projet n'a **pas d'owner Agent**. N'importe quel Agent peut sélectionner n'importe quel projet et travailler dessus. La spécialisation Agent↔projet est une préoccupation utilisateur, exprimée dans le `character`/`expertise`/prompt système de chaque Agent (ex: « Tu es le Agent dédié au projet X, commence chaque session par select_project("x") »).

### Ticket

Unité de travail au sein d'un projet. Possède un titre, une description, un statut (kanban) et des tags. Peut être créé par un utilisateur (via l'UI) ou par un Agent (via ses outils).

> Pas de notion de priorité au MVP. Si le besoin émerge, ajouter un champ texte libre ou un système de tags dédié plutôt qu'une enum figée.

### Task liée à un ticket

Le mécanisme d'exécution d'un ticket réutilise la primitive **task** (sub-Agent) existante. Un Agent appelle `start_ticket_task(ticket_id)` qui spawn un sub-Agent avec le contexte du projet et du ticket en prompt. Plusieurs tasks peuvent être liées au même ticket (relances, runs successifs, plusieurs Agents qui contribuent).

### Projet actif (par Agent)

Chaque Agent a un état `active_project_id` (nullable, persisté). Quand un projet est actif, son contexte est injecté dans le prompt système du Agent à chaque tour. Le projet actif peut être changé par l'utilisateur (via l'UI) ou par le Agent lui-même (via l'outil `set_active_project`). Singleton — un Agent n'a qu'un seul projet actif à la fois.

---

## 2. Modèle de données

### Nouvelles tables

#### `projects`

Entité projet indépendante.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `title` | text | NOT NULL | Titre du projet |
| `description` | text | NOT NULL, DEFAULT '' | Description complète — injectée dans le prompt système des Agents quand le projet est actif. Pas de cap dur en DB. |
| `github_url` | text | | URL du repo GitHub (metadata uniquement, pas d'intégration tool au MVP) |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_projects_created` sur `created_at` (pour le tri dans la sidebar)

> Pas de FK `user_id` / `owner_agent_id`. Les projets sont partagés entre tous les utilisateurs, conformément au principe Hivekeep (« les Agents sont partagés entre tous les utilisateurs »). Même règle pour les projets.

#### `project_tags`

Tags définis au niveau du projet. Bibliothèque propre à chaque projet — un tag créé dans le projet A n'existe pas dans le projet B.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `project_id` | text | FK → projects.id, ON DELETE CASCADE, NOT NULL | |
| `label` | text | NOT NULL | Libellé du tag (ex: 'bug', 'feature', 'urgent') |
| `color` | text | NOT NULL | Couleur hex (ex: '#ef4444'). Pas de palette imposée. |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Contrainte UNIQUE** : (`project_id`, `label`) — pas de doublons de labels dans un même projet.

**Index** :
- `idx_project_tags_project` sur `project_id`

> Pas de champ `is_default`. La liste standard de tags est définie en code (`src/shared/constants.ts → DEFAULT_PROJECT_TAGS`) et appliquée comme seed à la création de chaque projet. Après cela, l'utilisateur (ou un Agent) peut ajouter / modifier / supprimer librement.

#### `tickets`

Unités de travail.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `project_id` | text | FK → projects.id, ON DELETE CASCADE, NOT NULL | |
| `title` | text | NOT NULL | Titre du ticket |
| `description` | text | NOT NULL, DEFAULT '' | Détails du ticket |
| `status` | text | NOT NULL, DEFAULT 'backlog' | `'backlog' \| 'todo' \| 'in_progress' \| 'blocked' \| 'done'` |
| `position` | integer | NOT NULL, DEFAULT 0 | Ordre dans la colonne kanban (gaps de 1024 à l'insertion) |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_tickets_project_status_position` sur (`project_id`, `status`, `position` ASC) — pour le rendu kanban
- `idx_tickets_project_updated` sur (`project_id`, `updated_at` DESC) — pour les vues "récents"

#### `ticket_tags`

Liaison N-N tickets ↔ tags.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `ticket_id` | text | FK → tickets.id, ON DELETE CASCADE, NOT NULL | |
| `tag_id` | text | FK → project_tags.id, ON DELETE CASCADE, NOT NULL | |

**PK composite** : (`ticket_id`, `tag_id`)

**Index** :
- `idx_ticket_tags_ticket` sur `ticket_id`
- `idx_ticket_tags_tag` sur `tag_id`

### Modifications de tables existantes

#### `agents`

Ajout d'une colonne :

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `active_project_id` | text | FK → projects.id, ON DELETE SET NULL | Projet actif du Agent (NULL si aucun). État persistant. |

> Si le projet actif est supprimé, le Agent perd son contexte projet (`SET NULL`), pas d'erreur ni d'orphelin.

#### `tasks`

Ajout d'une colonne :

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `ticket_id` | text | FK → tickets.id, ON DELETE SET NULL | Ticket lié (NULL si task non liée à un ticket) |

**Index** :
- `idx_tasks_ticket` sur `ticket_id`

> Si le ticket est supprimé, les tasks historiques sont préservées (`SET NULL`) — important pour conserver l'audit trail dans le thread du Agent.

> Pas de colonne `additional_context` : le prompt-builder du sub-Agent lookup le ticket courant au runtime (description, tags, projet) plutôt que de figer le contexte au moment du spawn. Avantage : si l'utilisateur enrichit le ticket pendant que la task est en queue, la task voit la version à jour.

### Cascades — récapitulatif

| Suppression de | Effet |
|---|---|
| Projet | CASCADE : tickets, project_tags, ticket_tags (via les tickets) sont supprimés. `agents.active_project_id` mis à NULL pour les Agents concernés. `tasks.ticket_id` mis à NULL pour les tasks historiques liées aux tickets cascadés. |
| Ticket | CASCADE : ticket_tags supprimés. `tasks.ticket_id` mis à NULL. |
| Tag | CASCADE : `ticket_tags` supprimés (les tickets perdent juste ce tag). |

> Suppression projet = action utilisateur confirmée côté UI (modal "Êtes-vous sûr ? N tickets seront supprimés"). Aucune cascade ne s'exécute sans confirmation utilisateur.

---

## 3. Outils natifs Agent

Tous exposés dans `src/server/tools/project-tools.ts` (à créer). Conventions de flags (`readOnly`, `concurrencySafe`, `destructive`) conformes à `CLAUDE.md` § « Tool concurrency ».

### Projets

| Tool | Flags | Description |
|---|---|---|
| `list_projects()` | readOnly, concurrencySafe | Liste tous les projets (id, title, description courte, github_url) |
| `get_project(project_id)` | readOnly, concurrencySafe | Récupère un projet complet avec ses tickets non-`done` et ses tags |
| `create_project(title, description, github_url?, initial_tags?)` | — | Crée un projet. Si `initial_tags` omis, applique le seed `DEFAULT_PROJECT_TAGS`. |
| `update_project(project_id, fields)` | — | Modifie `title` / `github_url` (description : voir outils dédiés) |
| `update_project_description(project_id, content)` | — | Remplace la description complète |
| `append_project_description(project_id, text, separator?)` | — | Ajoute en fin (séparateur par défaut : `\n\n`). Utile pour ajouter une règle sans relire. |
| `patch_project_description(project_id, find, replace)` | — | Recherche-remplace précis. Erreur si `find` introuvable ou ambigu (multi-occurrences sans `replace_all` explicite). |
| `delete_project(project_id)` | destructive | Supprime un projet (cascade). |
| `set_active_project(project_id \| null)` | — | Définit ou réinitialise le projet actif du Agent appelant. Émet un event SSE pour mettre à jour l'UI. |

### Tags

| Tool | Flags | Description |
|---|---|---|
| `create_tag(project_id, label, color)` | — | Crée un tag dans un projet. Erreur si `(project_id, label)` existe déjà. |
| `update_tag(tag_id, fields)` | — | Modifie `label` ou `color`. |
| `delete_tag(tag_id)` | destructive | Supprime un tag (les ticket_tags associés sont cascadés). |

### Tickets

| Tool | Flags | Description |
|---|---|---|
| `list_tickets(project_id, filters?)` | readOnly, concurrencySafe | Liste paginée. Filtres : `status`, `tag_ids[]`, `limit`, `offset`. |
| `get_ticket(ticket_id)` | readOnly, concurrencySafe | Détail complet du ticket + ses tasks liées (id, status, parent_agent, created_at). |
| `create_ticket(project_id, title, description?, status?, tag_ids?)` | — | Crée un ticket. Status par défaut : `backlog`. Position : `max(position) + 1024` dans la colonne. |
| `update_ticket(ticket_id, fields)` | — | Modifie title / description / status / position. Sur changement de status, la position est recalculée pour atterrir en haut de la colonne cible (max + 1024). |
| `add_ticket_tag(ticket_id, tag_id)` | — | Ajoute un tag (idempotent). |
| `remove_ticket_tag(ticket_id, tag_id)` | — | Retire un tag. |
| `delete_ticket(ticket_id)` | destructive | Supprime un ticket. Tasks préservées (`ticket_id = NULL`). |

### Tasks liées à un ticket

| Tool | Flags | Description |
|---|---|---|
| `start_ticket_task(ticket_id)` | — | Spawn un sub-Agent avec le contexte du ticket. **Toujours en mode `await`** (aucun param `mode` exposé — voir § 5). **Aucun effet de bord sur le statut du ticket** : c'est au Agent de l'avoir mis à `in_progress` au préalable s'il le souhaite (cf. § 5 et `prompt-system.md` bloc [6]). |

> Pas d'outil dédié pour "lier une task existante à un ticket" — la liaison se fait toujours via `start_ticket_task`. Si un Agent veut bosser sur un ticket sans déléguer à un sub-Agent, il fait juste son travail dans son tour LLM et met à jour le ticket via `update_ticket`.

### Règle d'usage du projet actif

Les outils ticket prennent **toujours** un `project_id` ou `ticket_id` explicite. Le projet actif n'est pas un défaut implicite : si le Agent manipule le projet B alors que son projet actif est A, il doit explicitement passer `project_id = B` (et idéalement appeler `set_active_project(B)` avant pour la cohérence du contexte).

Justification : éviter les effets de bord silencieux où un outil modifierait un autre projet que celui visible dans le contexte du Agent.

---

## 4. Projet actif — mécanismes

### État persistant

`agents.active_project_id` (FK nullable). Lu à chaque construction de prompt, modifiable par :
- L'API REST `PATCH /api/agents/:id/active-project` (déclenchée par l'UI quand l'utilisateur clique sur un projet)
- L'outil Agent `set_active_project(id)` (déclenché par le Agent lui-même)

Les deux chemins émettent un event SSE `agent:active-project` (cf. § 8) pour que la UI se synchronise (ex: l'icône du projet dans la sidebar surligne le projet actif).

### Override temporaire (cas task)

Quand une task liée à un ticket termine (cf. § 5), le turn de réaction chez le Agent parent doit voir le contexte du projet du ticket, **même si le Agent a switché entre-temps**.

Implémentation : la fonction `buildSystemPrompt()` accepte un paramètre optionnel `projectOverride?: { projectId: string }`. Quand fourni, ce projet est injecté à la place de `agents.active_project_id` pour ce turn uniquement. La valeur persistée n'est pas modifiée.

Le agent-engine détecte le besoin d'override en lisant le `task_result` qui déclenche le turn : si la task a un `ticket_id`, on lookup `tickets.project_id` et on l'utilise comme `projectOverride`.

### Pas de défaut implicite sur les outils

Bien que le projet actif soit injecté dans le prompt, **aucun outil n'utilise `active_project_id` comme défaut**. Les outils ticket / tag exigent toujours un `project_id` explicite. Le projet actif sert uniquement au contexte de prompt, pas à la résolution d'arguments. Cf. § 3.

---

## 5. Flow : task spawned depuis un ticket

### Spawn

1. Le Agent appelle `start_ticket_task(ticket_id)`
2. Le service tasks crée une row `tasks` :
   - `ticket_id` = ticket_id passé
   - `parent_agent_id` = id du Agent appelant
   - `spawn_type` = 'self' (le sub-Agent clone le Agent parent)
   - `mode` = **toujours `'await'`** (voir ci-dessous, pas de paramètre exposé)
   - `description` = "Travailler sur le ticket : {ticket.title}" (court — le détail vient du prompt-builder, voir § 6)
3. **Aucun side-effect sur le ticket.** Le statut, la position, les tags ne sont pas modifiés. Le Agent est responsable de maintenir le ticket à jour avant et après. Une instruction le rappelle dans `prompt-system.md` bloc [6] "Hidden system instructions".
4. Le sub-Agent est enqueué et démarre son turn LLM normalement.

### Pourquoi `await` obligatoire ?

Le mode `async` (fire-and-forget) dépose le résultat de la task dans l'historique sans déclencher de turn LLM sur le parent. Combiné avec le principe "le Agent gère manuellement le statut du ticket", ça donnerait : tu spawn une task async, elle finit, personne ne met à jour le ticket → état figé.

Donc règle : tasks liées à un ticket = toujours `await`. Le service valide explicitement : si une autre source (futur webhook, futur cron) tente de spawner une task avec `ticket_id !== null` et `mode = 'async'`, refus avec code d'erreur `TICKET_TASK_REQUIRES_AWAIT`.

### Exécution du sub-Agent

Quand le prompt-builder construit le prompt du sub-Agent, il détecte `task.ticket_id !== null` et :
- Lookup `ticket` + `project` correspondants (toujours la version à jour, pas de snapshot figé)
- Injecte un bloc dédié dans le `stableBlocks` du sub-Agent (cf. § 6.4) avec : titre projet, description projet, titre ticket, description ticket, statut, tags.
- Le sub-Agent a accès aux outils ticket (read + update) hérités du Agent parent.

### Restitution (mode await)

À la fin de la task :
- `update_task_status('completed', result)` ou `('failed', ..., reason)`
- Un message de type `task_result` entre dans la queue FIFO du **Agent parent** (= `tasks.parent_agent_id`)
- **Format enrichi** quand `task.ticket_id !== null` : au préfixe existant `[Task: {task.description}] Result: {result}` est concaténé un rappel inline qui oriente le Agent vers la mise à jour du ticket :

  ```
  [Task: {task.description}] Result: {result}

  ---
  Linked ticket: #{id_short} "{ticket.title}" (project: {project.title}, current status: {ticket.status}).
  Review the result above and update the ticket via update_ticket() if needed — status, description, tags. The kanban does not move automatically.
  ```

  Le rappel n'apparaît **que** pour les tasks liées à un ticket. Pour les tasks classiques, le format historique reste inchangé.
- Le turn LLM qui en résulte est construit avec `projectOverride = { projectId: ticket.project_id }` (cf. § 4)
- Le Agent parent lit le résultat + le rappel, décide, et peut appeler `update_ticket(status='done')` ou autre

> Si le projet du ticket a été supprimé entre le spawn et la completion, le rappel n'est pas injecté (le ticket et le projet n'existent plus, le rappel serait incorrect). Le message reste au format historique. Le `projectOverride` n'est pas posé non plus. Voir `prompt-system.md` § sub-Agent ticket assignment block pour le fallback équivalent côté sub-Agent.

### Routage

Le résultat va **toujours** au Agent qui a spawn la task (`parent_agent_id`). Si l'utilisateur a basculé en cours de route sur un autre Agent dans l'UI, le résultat arrive quand même chez le bon Agent (silencieusement, mais avec un badge SSE-driven sur l'icône du Agent dans la sidebar du mode Agents pour notifier).

### Plusieurs tasks par ticket

Aucune contrainte d'unicité. Cas usuels :
- Une task échoue → le Agent (ou l'utilisateur) relance `start_ticket_task` → nouvelle row. Le statut du ticket reste celui décidé par le Agent/utilisateur (probablement `in_progress` s'il a été mis là, sinon ce qui était avant).
- Plusieurs Agents contribuent à un même ticket → chacun spawn ses propres tasks
- La carte ticket dans le kanban affiche l'historique : `Task #1 (Agent Alpha) — done · Task #2 (Agent Beta) — running`

---

## 6. Bloc projet actif dans le prompt système

### 6.1 Placement (cache-aware)

Le prompt-builder existant (`src/server/services/prompt-builder.ts`) sépare déjà le prompt en `{ stable, volatile }` avec un cache breakpoint entre les deux (cf. comment du fichier, lignes 452-469).

Le bloc projet actif est **volatile** : il change quand le Agent switche de projet. Il rejoint donc les `volatileBlocks` — aux côtés de memories, contacts résumés, current speaker, language, workspace tree, date.

Conséquence : switcher de projet n'invalide que le segment volatile (déjà recalculé à chaque tour). Le prefixe stable (identité, character, expertise, hidden instructions, agent directory, MCP) reste en cache.

### 6.2 Position dans la séquence volatile

Le bloc projet actif est ajouté **avant** le bloc « Final reminder » ([8.5]) qui reste impérativement en dernier (pour la recency bias). Position recommandée : juste après le bloc « Workspace » ([7.7]) et avant « Date and current context » ([8]).

L'ordre final des `volatileBlocks` après modification :

```
... blocs existants (memories, contacts, speaker, language, workspace) ...
→ PROJECT (si active_project_id ou projectOverride)
→ Date / Context
→ Final reminder (toujours en dernier)
```

### 6.3 Contenu du bloc — Agent principal

Quand `active_project_id` (ou `projectOverride`) résout un projet :

```
## Active project

You are currently working on the following project. Use the project tools
to inspect tickets, update their status, and start tasks.

Title: {project.title}
{if project.github_url}GitHub: {project.github_url}{/if}

### Description

{project.description}

### Tags

- {tag.label} ({tag.color})
- {tag.label} ({tag.color})
...

### Open tickets ({non-done count})

- [{status}] [#{ticket.id_short}] {ticket.title}{if tags} — {tag_labels}{/if}
- ...

> To switch project, call set_active_project(other_project_id) or set_active_project(null) to deactivate.
```

**Cap pratique** : la description complète est injectée tant qu'elle reste sous **8 000 tokens estimés** (≈ 32 ko de texte brut). Au-delà, le bloc affiche les 4 000 premiers tokens + une mention `[Description truncated — call get_project() to read the full text]`. Cap configurable via `config.projects.maxDescriptionPromptTokens`.

**Liste tickets** : limitée aux 50 tickets non-`done` les plus récemment mis à jour. Au-delà : `... and N more — call list_tickets() to inspect`.

### 6.4 Contenu du bloc — Sub-Agent lié à un ticket

Quand un sub-Agent est exécuté avec `task.ticket_id !== null`, le bloc est plus complet et fait référence au ticket spécifique :

```
## Ticket assignment

You are executing a delegated task for a specific ticket.

### Project context

Title: {project.title}
{if project.github_url}GitHub: {project.github_url}{/if}

Description:
{project.description}

### Ticket you are working on

Title: {ticket.title}
Status: {ticket.status}
{if tags}Tags: {tag_labels}{/if}

Description:
{ticket.description}

> Use update_ticket() to update the ticket as you progress (status, description, tags).
> Report back to the parent Agent with report_to_parent() / update_task_status() as usual.
```

Le bloc est injecté dans les `stableBlocks` du sub-Agent (juste après « Your mission »), car pour la durée d'une task, le ticket assigné est figé.

> Le sub-Agent hérite des outils ticket (lecture + update) de son parent. Mécanisme à confirmer dans la phase d'implémentation : par défaut, les sub-Agents n'ont pas accès à tous les outils du parent (cf. `prompt-system.md` [12]). Il faudra ajouter les outils ticket à la liste des outils sub-Agent quand `task.ticket_id !== null`.

---

## 7. API REST

Conventions : camelCase dans les payloads JSON, `{ resource: {...} }` pour les retours singuliers, `{ resources: [...] }` pour les listes, erreurs `{ error: { code, message } }`. Toutes routes auth membre (pas admin-only) sauf mention contraire.

### Projets

#### `GET /api/projects`

```typescript
// Response 200
{
  projects: Array<{
    id: string
    title: string
    githubUrl: string | null
    ticketCount: number
    openTicketCount: number      // status !== 'done'
    createdAt: number
    updatedAt: number
    // description omise pour la liste (peut être volumineuse)
  }>
}
```

#### `GET /api/projects/:id`

```typescript
// Response 200
{
  project: {
    id: string
    title: string
    description: string
    githubUrl: string | null
    tags: Array<{ id: string, label: string, color: string }>
    ticketCounts: { backlog: number, todo: number, in_progress: number, blocked: number, done: number }
    createdAt: number
    updatedAt: number
  }
}
```

#### `POST /api/projects`

```typescript
// Request
{
  title: string
  description?: string
  githubUrl?: string
  // Pas de initial_tags ici — le seed est appliqué côté serveur
}

// Response 201
{ project: { ...same as GET /api/projects/:id } }
```

#### `PATCH /api/projects/:id`

```typescript
// Request (tous optionnels)
{
  title?: string
  description?: string     // remplace tout (les outils Agent offrent append/patch)
  githubUrl?: string | null
}

// Response 200
{ project: { ...same shape } }
```

#### `DELETE /api/projects/:id`

```typescript
// Response 200
{ success: true }
```

### Tags

#### `GET /api/projects/:projectId/tags`

```typescript
// Response 200
{
  tags: Array<{
    id: string
    label: string
    color: string
    createdAt: number
  }>
}
```

#### `POST /api/projects/:projectId/tags`

```typescript
// Request
{ label: string, color: string }

// Response 201
{ tag: { id, label, color, createdAt } }

// Errors
// 409 — { error: { code: 'TAG_LABEL_TAKEN', message: 'A tag with this label already exists in this project' } }
```

#### `PATCH /api/tags/:id`

```typescript
// Request
{ label?: string, color?: string }

// Response 200
{ tag: { ...same shape } }
```

#### `DELETE /api/tags/:id`

```typescript
// Response 200
{ success: true }
```

### Tickets

#### `GET /api/projects/:projectId/tickets`

```typescript
// Query params : ?status={...}&tagId={...}&limit={...}&offset={...}

// Response 200
{
  tickets: Array<{
    id: string
    projectId: string
    title: string
    description: string         // tronquée à 500 chars pour la liste
    status: 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done'
    position: number
    tags: Array<{ id, label, color }>
    taskCount: number           // nombre total de tasks liées
    runningTaskCount: number    // tasks status in_progress/pending/queued
    createdAt: number
    updatedAt: number
  }>
  hasMore: boolean
}
```

#### `GET /api/tickets/:id`

```typescript
// Response 200
{
  ticket: {
    ...same shape as list item (description complète, pas tronquée)
    tasks: Array<{
      id: string
      parentAgentId: string
      parentAgentName: string
      status: string
      mode: 'await' | 'async'
      createdAt: number
      updatedAt: number
      // result/error fournis seulement via GET /api/tasks/:id pour ne pas alourdir
    }>
  }
}
```

#### `POST /api/projects/:projectId/tickets`

```typescript
// Request
{
  title: string
  description?: string
  status?: 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done'
  tagIds?: string[]
}

// Response 201
{ ticket: { ...same shape as GET /api/tickets/:id } }
```

#### `PATCH /api/tickets/:id`

```typescript
// Request (tous optionnels)
{
  title?: string
  description?: string
  status?: string
  position?: number          // si fourni : place à cette position. Sinon : max+1024 dans la colonne du nouveau status.
  tagIds?: string[]          // remplace l'ensemble (PUT-like)
}

// Response 200
{ ticket: { ...same shape } }
```

#### `DELETE /api/tickets/:id`

```typescript
// Response 200
{ success: true }
```

#### `POST /api/tickets/:id/start-task`

Spawn un sub-Agent pour travailler sur le ticket. L'API impose un `agentId` explicite dans le body (cf. règle "pas de défaut implicite"). **Toujours en mode await** — pas de param `mode`.

```typescript
// Request
{
  agentId: string              // Agent qui spawn la task (= parent_agent_id)
}

// Response 201
{
  task: {
    id: string
    parentAgentId: string
    ticketId: string
    status: string
    createdAt: number
  }
}
```

> Aucun effet de bord sur le ticket. Le statut, la position, les tags ne sont pas modifiés. Le Agent (ou l'utilisateur via drag-drop) est responsable de mettre le ticket à `in_progress` au préalable s'il veut que le kanban reflète l'avancement.

> Côté UI : le bouton "Démarrer une task" demande à l'utilisateur quel Agent doit l'exécuter (dropdown des Agents disponibles). Pré-sélection : le premier Agent ayant `active_project_id = ticket.project_id`. Le choix reste explicite.

### Agent — projet actif

#### `PATCH /api/agents/:id/active-project`

```typescript
// Request
{ projectId: string | null }

// Response 200
{ activeProjectId: string | null }

// Errors
// 404 — projet inexistant
```

### Événements SSE supplémentaires

Ajoutés au SSE global existant (`GET /api/sse`) :

```typescript
// Projet actif d'un Agent changé
{ event: 'agent:active-project', data: { agentId: string, activeProjectId: string | null } }

// Projet créé / modifié / supprimé
{ event: 'project:created', data: { project: ProjectSummary } }
{ event: 'project:updated', data: { project: ProjectSummary } }
{ event: 'project:deleted', data: { projectId: string } }

// Ticket créé / modifié / supprimé / déplacé
{ event: 'ticket:created', data: { ticket: TicketSummary } }
{ event: 'ticket:updated', data: { ticket: TicketSummary } }      // inclut changement de status/position
{ event: 'ticket:deleted', data: { ticketId: string, projectId: string } }

// Tag CRUD
{ event: 'project-tag:created', data: { tag: TagShape, projectId: string } }
{ event: 'project-tag:updated', data: { tag: TagShape, projectId: string } }
{ event: 'project-tag:deleted', data: { tagId: string, projectId: string } }
```

> Les événements `task:*` existants restent inchangés. Les clients qui s'intéressent aux tasks liées aux tickets filtrent côté frontend sur `task.ticketId !== null`.

---

## 8. Navigation et UI

### 8.1 Activity bar verticale

Nouvelle bande verticale à l'extrême gauche, ≈ 48-56 px. Mountée au root du layout, indépendante de la sidebar contextuelle.

```
┌──┬──────────────┬────────────────────────┬─────────────┐
│🏠│  Sidebar     │  Vue principale        │ Side panel  │
│⊞ │  (contextuel │  (contextuel au mode)  │ (global,    │
│  │   au mode)   │                        │  collapsible│
│  │              │                        │  on demand) │
│  │              │                        │             │
│⚙ │              │                        │             │
└──┴──────────────┴────────────────────────┴─────────────┘
```

Icônes au MVP :
- **Agents** (🏠 ou icône équivalente Lucide) — mode existant : sidebar avec Agents / Tasks / Crons / Mini-apps / Settings + thread principal
- **Projets** (⊞ ou Trello-like) — nouveau mode : sidebar liste projets + kanban
- **Settings / compte** restent accessibles via les patterns existants (badge avatar en bas, ou intégrés dans la sidebar Agents)

L'icône sélectionnée a un indicateur visuel (fond surligné, bordure gauche, ou similar — à aligner avec le design system).

### 8.2 Mode Projets — sidebar

Liste des projets, triée par défaut sur `updated_at DESC`. Chaque entrée affiche :
- Titre du projet
- Compteur de tickets ouverts (`status !== 'done'`)
- Pastille si au moins un Agent a ce projet en `active_project_id` (avec tooltip listant les Agents concernés)
- Bouton "+ Nouveau projet" en haut

Clic sur un projet → la vue principale affiche son kanban. Le projet ne devient **pas** automatiquement le projet actif d'un Agent — c'est une décision séparée (cf. § 8.5).

### 8.3 Mode Projets — vue kanban

5 colonnes : Backlog, À faire, En cours, Bloqué, Terminé. Drag & drop entre colonnes via une lib type `dnd-kit` (à choisir au moment de l'implémentation).

Chaque carte ticket affiche :
- Titre
- Tags (chips colorés)
- Compteur de tasks : `🔄 2 (1 running)` cliquable → ouvre le side panel sur le ticket (`openTicket`)
- Mini-avatar du dernier Agent ayant agi sur le ticket

Au-dessus du kanban : header avec titre du projet, bouton "Ouvrir la description" (qui ouvre le side panel sur le ticket projet, ou un mode édition inline à choisir au moment du build), bouton "+ Nouveau ticket".

### 8.4 Side panel global (ex-"Inspector")

Refactor pré-requis (cf. § 11.1) : le panneau latéral existant (qui héberge déjà mini-apps + détail task via [`MiniAppContext`](src/client/contexts/MiniAppContext.tsx)) doit être **lifté au root du layout** et **renommé** en `SidePanelContext` / `useSidePanel`. L'approche réutilise toute la mécanique existante (rendering panel, gestion des tabs, hook task streaming) au lieu de créer un système Inspector parallèle.

État actuel à conserver :
- Le slot panneau de droite est géré par `MiniAppViewer.tsx`, qui rend selon `activeTab` (`'mini-app'` ou `'task'`)
- Le tab `'task'` accueille `TaskPanelContent` avec tout le détail task (messages, tool calls, streaming SSE, etc.)
- Le tab `'mini-app'` accueille la mini-app active dans une iframe

Ce qu'on ajoute :
- Un troisième type de tab : `'ticket'` (implémenté en Phase 26.7)
- Méthode `openTicket(info)` sur le context
- Pour la nav nested (task ouverte depuis un ticket avec bouton retour), un petit système `parentRef` optionnel sur les `openTask` / `openTicket` — implémenté quand on aura le besoin réel (Phase 26.7)

API d'invocation côté frontend (existant + extensions) :

```ts
const { openApp, openTask, openTicket, closePanel, switchTab } = useSidePanel()

openApp(appId)                                              // existant
openTask({ taskId, agentName, agentAvatarUrl })                 // existant
openTicket({ ticketId })                                    // NEW (Phase 26.7)
openTask({ taskId, ..., parent: { type: 'ticket', id } })   // NEW pattern parent (Phase 26.7)
closePanel()
```

Types d'entités prises en charge à la fin de Phase 26 :
- **Mini-app** (existante)
- **Task** (existante)
- **Ticket** (nouvelle, Phase 26.7)
- (Futur : Agent profile, Cron run, etc.)

Le pattern "single-slot avec retour parent" est implémenté de manière incrémentale : un champ `parent` optionnel est posé sur la dernière entité ouverte ; si présent, le header du panel affiche un bouton retour. Pas de stack à profondeur > 1 au MVP.

### 8.5 Cross-linking

Pour éviter que les deux modes ne deviennent des silos :

| Depuis | Action | Effet |
|---|---|---|
| Thread Agent (mode Agents) | Mention de ticket dans un message (markdown auto-linkifié `[#abc12]`) | Ouvre le side panel sur le ticket (reste en mode Agents) |
| Header thread Agent | Chip "Projet actif: ✦ {title}" | Clic = bascule mode Projets sur ce projet (volontaire) |
| Header thread Agent (sans projet actif) | Chip "Aucun projet" | Optionnel : dropdown pour sélectionner. À évaluer en design. |
| Carte ticket kanban | Clic | Ouvre le side panel sur le ticket (`openTicket`) |
| Side panel tab `'ticket'` | Lien sur chaque task → "Voir thread Agent Alpha" | Bascule mode Agents, focus Agent Alpha, scroll vers le message qui contient la task |
| Side panel tab `'task'` | Lien "→ Voir le ticket parent" (si parent ticket renseigné) | Reste en mode courant, side panel remonte sur le ticket (`openTicket`) |
| Notification badge sur icône activity bar | Le mode inactif accumule des changements (nouveau ticket, task done, etc.) | Pastille avec compteur, optionnel toast pour évènements forts |

**Règle d'or** : aucun clic ne fait basculer de mode silencieusement. Tout changement de mode est soit un clic sur l'activity bar, soit un clic sur un lien explicitement libellé "Voir dans...".

### 8.6 Bouton "Démarrer une task" — UI

Sur la carte ticket et dans le side panel (tab ticket) :
- Bouton "▶ Démarrer une task"
- Dropdown : "Avec quel Agent ?" (liste des Agents)
- **Pré-sélection** : si un ou plusieurs Agents ont `active_project_id = ticket.project_id`, pré-sélectionner le premier (par ordre alphabétique ou par `agent_order` user). Cas usuel : un seul Agent avec ce projet actif → sélection auto. Cas rare : plusieurs → l'utilisateur peut ajuster le dropdown.
- Pas d'option mode (`await` est imposé pour les tasks liées à un ticket — voir § 5)
- Validation → `POST /api/tickets/:id/start-task`

Après le clic : la carte ticket affiche immédiatement (optimistic) un badge "running task". **La carte ne change pas de colonne automatiquement** — si l'utilisateur veut refléter "en cours", il drag la carte lui-même, ou il laisse le Agent le faire dans sa boucle de travail. Conséquence visible : une carte peut afficher un badge "running task" même en colonne `Backlog` ou `À faire`. C'est informatif et voulu (le badge dit qu'un Agent travaille dessus actuellement, indépendamment du statut kanban formel).

---

## 9. Frontend — composants

À créer (alignés sur les conventions `structure.md` et le design system Phase 0.5) :

| Fichier | Rôle |
|---|---|
| `src/client/pages/projects/ProjectsPage.tsx` | Page principale du mode Projets (sidebar + kanban) |
| `src/client/components/sidebar/ProjectsSidebar.tsx` | Sidebar contextuelle (liste projets, bouton créer) |
| `src/client/components/project/ProjectKanban.tsx` | Vue kanban du projet sélectionné |
| `src/client/components/project/TicketCard.tsx` | Carte ticket dans une colonne |
| `src/client/components/project/TicketColumn.tsx` | Colonne kanban (drop target) |
| `src/client/components/project/CreateProjectModal.tsx` | Modal de création |
| `src/client/components/project/CreateTicketModal.tsx` | Modal de création de ticket |
| `src/client/components/project/StartTaskDialog.tsx` | Modal de démarrage de task |
| `src/client/components/project/TagPicker.tsx` | Sélecteur de tags multi avec création inline |
| `src/client/contexts/SidePanelContext.tsx` | **Renommage** de `MiniAppContext.tsx`. Hook exporté : `useSidePanel()` (ex-`useMiniAppPanel`). Lifté au root du layout. |
| `src/client/components/sidebar/TicketPanelContent.tsx` | Détail ticket — nouveau composant chargé dans le tab `'ticket'` du side panel (Phase 26.7) |
| `src/client/components/sidebar/TaskPanelContent.tsx` | **Existant** (633 lignes), conservé tel quel. Pas de déplacement. |
| `src/client/components/mini-app/MiniAppViewer.tsx` | **Existant**, conservé. Lifté au root du layout en Phase 26.0. Étendu en Phase 26.7 pour router vers `TicketPanelContent` quand `activeTab === 'ticket'`. |
| `src/client/components/layout/ActivityBar.tsx` | Bande verticale de switch de mode (Agents / Projets) |
| `src/client/hooks/useProjects.ts` | Hook données projets |
| `src/client/hooks/useTickets.ts` | Hook données tickets |
| `src/client/hooks/useActivityBar.ts` | Store global du mode actif |

i18n : nouvelles clés sous `projects.*` dans `src/client/locales/en.json` et `fr.json`.

---

## 10. Configuration

Nouvelles entrées dans `src/server/config.ts` :

| Clé | Type | Défaut | Description |
|---|---|---|---|
| `projects.maxDescriptionPromptTokens` | number | 8000 | Cap d'injection de la description projet dans le prompt système (au-delà : tronqué + mention) |
| `projects.maxTicketsInPrompt` | number | 50 | Nombre max de tickets non-`done` injectés dans le bloc projet du prompt |
| `projects.kanbanPositionStep` | number | 1024 | Gap d'incrément pour les positions kanban (insertion au top de colonne = max + step) |

À documenter dans `config.md` au moment des compléments.

---

## 11. Edge cases et règles

### 11.1 Pré-requis : lift + rename du side panel

Le panneau latéral actuel (qui héberge mini-apps et détail task) vit dans la page Agents via [`MiniAppProvider`](src/client/contexts/MiniAppContext.tsx) monté à [ChatPage.tsx:207](src/client/pages/chat/ChatPage.tsx#L207) et [`MiniAppViewer`](src/client/components/mini-app/MiniAppViewer.tsx) rendu dans [`ChatPanel`](src/client/components/chat/ChatPanel.tsx). C'est ce qui empêche aujourd'hui un autre mode (Projets) d'accéder au panneau.

Approche retenue : **lift + rename de l'existant**, pas de création d'un Inspector parallèle. On réutilise toute la mécanique (rendering, tab switching, hook `useTaskDetail` avec 633 lignes de gestion SSE).

Étapes (cf. `DEVELOPMENT_PLAN.md` § 26.0) :
1. Renommer `MiniAppContext.tsx` → `SidePanelContext.tsx`, `useMiniAppPanel` → `useSidePanel`. Mettre à jour tous les imports.
2. Lifter `<SidePanelProvider>` de `ChatPage` vers `AppRoot` (`src/client/App.tsx`).
3. **Lift partiel pour le Viewer** : `<MiniAppViewer />` reste rendu dans `ChatPanel`. Chaque page qui veut utiliser le side panel le rendra dans son propre layout (ProjectsPage le fera en Phase 26.6). Justification : lifter le Viewer au root nécessiterait de restructurer le layout shadcn `SidebarInset`/`h-svh` de ChatPage avec un risque de régression supérieur au gain. Coût accepté : ~1s de retard sur les tokens streaming lors d'un switch de mode (couvert par le polling fallback à 1Hz de `useTaskDetail`).
4. Étendre `ActiveTab` du context pour préparer le type `'ticket'` (Phase 26.7 implémentera le rendu).
5. Conserver le tab `'mini-app'` lié à la page Agents (le bouton `openApp` n'est invoqué que depuis chat — pas de changement UX).
6. Vérifier que les évènements SSE existants (`task:status`, `task:done`, streaming) continuent à fonctionner après le lift.

Ce refactor est la **première sous-tâche** de la phase 26 dans `DEVELOPMENT_PLAN.md`. Aucun code projet n'est écrit avant qu'il soit terminé et validé.

### 11.2 Suppression projet — tasks "in flight"

Un projet peut être supprimé alors que des tasks liées à ses tickets sont en cours d'exécution.

Décision : **les tasks en cours ne sont pas annulées**. Elles continuent à tourner. À la fin :
- `update_task_status` réussit toujours
- Le `task_result` est tout de même délivré au Agent parent
- Le `projectOverride` détecte que `ticket.project_id` pointe vers un projet inexistant → fallback gracieux : injecte un bloc dégradé `"## Note: the project this ticket belonged to has been deleted."` au lieu du bloc complet

Justification : (a) c'est le comportement le moins surprenant, (b) annuler des tasks en cours peut perdre du travail utile.

Côté UI : avant la confirmation de suppression, afficher un warning si des tasks sont en cours : "N tâche(s) en cours seront poursuivies sans contexte projet."

### 11.3 Multi-Agent sur le même projet

Aucune contrainte. Plusieurs Agents peuvent avoir `active_project_id = X` simultanément. Chacun a sa propre boucle de travail (queue FIFO indépendante). Pas de verrou, pas de "qui a la main".

Si deux Agents modifient le même ticket en parallèle (ex: tous deux passent un ticket à `done`), c'est last-write-wins au niveau de la DB. Pas de mécanisme de merge — la granularité ticket le rend acceptable.

### 11.4 Tags entre projets — pas de partage

Les tags ne sont pas globaux. Recréer "bug" dans chaque projet est explicite et voulu : la palette de tags fait partie de la définition du projet. Si l'utilisateur veut une palette cohérente, il la définit via le seed `DEFAULT_PROJECT_TAGS` (cf. § 2).

### 11.5 Renommage / déplacement d'un ticket entre projets

**Pas supporté au MVP.** Un ticket appartient à un projet, point. Si l'utilisateur veut "déplacer" un ticket, il en crée un nouveau dans le projet cible et supprime l'ancien. Justification : le déplacement casse les tasks historiques (qui pointent toujours vers l'ancien `ticket_id`) et la cohérence des tags. À reconsidérer si besoin réel apparaît.

### 11.6 GitHub URL — pas de validation

`projects.github_url` est un simple champ texte. Pas de validation de format au MVP. L'utilisateur peut y mettre n'importe quoi (URL GitHub, GitLab, lien Notion). Le nom du champ peut être ajusté à `external_url` ou `link` plus tard si le scope s'élargit — pour le MVP on garde `github_url` pour cohérence avec la demande initiale.

### 11.7 Pas d'historique de modification

Pas de table `ticket_history` ni `project_history` au MVP. `updated_at` sur les rows suffit. Si l'utilisateur veut tracer les changements d'un ticket, il a accès aux thread des Agents (qui ont éventuellement appelé `update_ticket`).

### 11.8 Cron + ticket — pas au MVP

Un cron pourrait théoriquement spawner une task liée à un ticket (ex: cron quotidien qui vérifie l'état d'un ticket et le commente). Pas implémenté au MVP : le schéma `tasks.ticket_id` le permet techniquement, mais aucun outil cron ne le pose. À ajouter dans une phase ultérieure si besoin.

---

## 12. Hors scope MVP

| Feature | Raison du report |
|---|---|
| Vues alternatives (liste, gantt, calendar) | Kanban suffit pour démarrer |
| Statuts customisables par projet | Figés sur 5 valeurs pour valider l'usage avant de complexifier |
| Sub-tickets (parent/child) | Pas de besoin remonté |
| Dépendances entre tickets (blocks/blocked-by) | Pas de besoin remonté |
| Champs custom par projet | Trop early |
| Commentaires sur les tickets | Le thread du Agent sert d'historique conversationnel |
| Attachments sur les tickets | Hors scope du module ; les Agents peuvent attacher des fichiers via leur workspace |
| Permissions par utilisateur / par projet | Tout est partagé, cf. principe Hivekeep |
| Intégration GitHub réelle (issues, PR, commits) | Metadata only au MVP, intégration ultérieure |
| Plan / planification pré-task explicite (entité `plan`) | L'enrichissement via `update_ticket` ou message dans le thread suffit au MVP |
| Webhook entrant pour créer / modifier des tickets | Les webhooks existants ne sont pas câblés sur les projets au MVP |
| Recherche full-text sur les tickets | Pas de FTS5 supplémentaire au MVP — la liste filtrée par status/tags suffit |

---

## 13. Arbitrages flaggés à valider pendant l'implémentation

1. **Outils ticket dans le sub-Agent** : les outils projet/ticket sont **universels** — pas de notion de permission par Agent, n'importe quel Agent peut les utiliser sur n'importe quel projet. Règle d'injection : quand `task.ticket_id !== null`, ajouter au toolset du sub-Agent **le même set d'outils projet/ticket que celui exposé au Agent principal du main thread** (`get_project`, `get_ticket`, `list_tickets`, `update_ticket`, `add_ticket_tag`, `remove_ticket_tag`, `update_project_description`, `append_project_description`, `patch_project_description`). On exclut `delete_project` et `delete_ticket` pour éviter qu'un sub-Agent nuke le contexte de son propre run. Pas besoin de walker la chaîne `parent_task_id` : c'est juste un set fixe injecté quand la condition est remplie.

2. **Compteur de tasks "running"** dans la liste tickets : la query peut être coûteuse si beaucoup de tickets. Si problème de perf, passer par un trigger qui maintient un cache sur `tickets.running_task_count` (denormalization). À mesurer.

3. **Drag & drop kanban** : choix de la lib (`dnd-kit` recommandé, mais `react-beautiful-dnd` ou `framer-motion` envisageables). À trancher au moment du composant `ProjectKanban.tsx`.

4. **Mention de ticket dans le thread** : auto-link de `[#abc12]` ou `#abc12` dans les messages markdown. Mécanisme à câbler dans `MarkdownContent.tsx` (rendu) — peut-être différable post-MVP.

5. **Cap de description projet dans le prompt** : 8000 tokens est arbitraire. À ajuster après les premiers tests réels avec de grosses descriptions.

6. **Seed `DEFAULT_PROJECT_TAGS`** : palette à valider en design system.
   - bug (`#ef4444`)
   - feature (`#3b82f6`)
   - chore (`#6b7280`) — housekeeping, bumps de version, refactor mineur
   - doc (`#f59e0b`)
   Pas de tag "urgent" ni "priority-*" — la priorité n'est pas modélisée au MVP (cf. § 1).
