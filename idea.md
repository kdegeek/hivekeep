# Hivekeep

## Description du projet

Hivekeep est une plateforme d'**agents IA spécialisés** conçue pour assister une personne ou un petit groupe (famille, amis, colocation) dans leur quotidien.

Le principe : l'utilisateur crée des **Agents** — des agents experts dans un domaine précis (nutrition, finance personnelle, organisation de voyages, développement, rédaction, recherche...). Chaque Agent a sa personnalité, ses connaissances, ses outils, et une mémoire continue de toutes les interactions passées. Les Agents peuvent collaborer entre eux, déléguer des sous-tâches, et exécuter des tâches planifiées de manière autonome.

Contrairement aux chatbots classiques ou chaque conversation repart de zéro, un Agent **connaît son contexte** : il sait qui lui parle, ce qui a été demandé précédemment, et peut agir de manière proactive. C'est un assistant permanent, pas un outil jetable.

Hivekeep est une application web auto-hébergée (a domicile ou sur un VPS), multi-utilisateur, pensée pour rester **simple a déployer et a maintenir**.

---

## 1. Onboarding

La première connexion a l'interface lance un onboarding **minimaliste** dont le seul rôle est de créer le premier utilisateur (administrateur). Toute la configuration (providers AI, providers search, modèles par défaut, premier Agent…) est ensuite proposée depuis l'application elle-même, jamais comme un mur d'entrée bloquant.

Principe : `completed = hasAdmin`. Tant qu'aucun administrateur n'existe, on est en onboarding ; dès qu'un profil admin est créé, on a accès a l'application entière.

### Ecran 1 - Identité de l'utilisateur

Champs requis :
- Photo / Avatar (optionnel)
- Prénom
- Nom
- Email
- Pseudonyme
- Mot de passe (avec confirmation)

### Ecran 2 - Préférences

- Langue (Français ou Anglais)
- Fuseau horaire (auto-détecté, modifiable)

A la sortie de l'écran 2, l'utilisateur arrive directement sur le dashboard principal (vue Agents + conversations). Aucun provider n'est requis pour franchir ce cap.

### Setup Checklist (post-onboarding, dans l'app)

Sur le dashboard, tant que la configuration n'est pas complète, une **checklist d'amorçage** suit l'utilisateur pour le guider. Elle se présente sous deux formes : un encart inline sur l'écran vide d'une conversation, et un popover compact accessible depuis la navbar.

La checklist contient 7 items, chacun **skippable individuellement** (le skip est persisté globalement dans `app_settings.dismissed_setup_items` — pas per-user, car Hivekeep est un produit individuel ou petit groupe avec configuration partagée) :

| ID | Description | Impact si absent |
|---|---|---|
| `add_llm_provider` | Configurer un provider LLM | Aucun Agent ne peut répondre |
| `set_default_llm` | Choisir un LLM par défaut | Le wizard de création de Agent tombe en mode manuel |
| `add_embedding_provider` | Configurer un provider d'embedding | La mémoire bascule en recherche keyword (FTS5) uniquement |
| `set_default_embedding` | Choisir un modèle d'embedding par défaut | Idem — pas de recherche sémantique |
| `add_image_provider` | Configurer un provider d'image | Pas de génération automatique d'avatars de Agents |
| `add_search_provider` | Configurer un provider de recherche web | L'outil `web_search` renverra une erreur a l'appel |
| `create_first_agent` | Créer son premier Agent | Aucune conversation possible |

Tant que `add_llm_provider` est en attente, la création de Agent via wizard est désactivée (le bouton Generate est gris) mais le mode manuel reste accessible. La même logique s'applique partout dans l'UI : **graceful degradation**, jamais de blocage opaque. Les bannières capability-aware (`useHasCapability('image' | 'search' | 'tts' | 'stt' | 'embedding')`) surfacent la cause exacte au point d'usage avec un CTA vers Settings → Providers.

Restauration d'items dismissés : Settings → General → "Show setup checklist".

---

## 2. Interface principale

### Direction design

L'interface de Hivekeep doit être **clean et soignée**, tout en gardant un côté **chaleureux et ludique**. On ne cherche pas l'austérité d'un outil enterprise, ni le côté enfantin d'une app gamifiée. L'objectif est un équilibre entre professionnalisme et personnalité.

| Aspect | Direction |
|---|---|
| **Ton général** | Moderne, aéré, accueillant — dans l'esprit de Notion ou Arc Browser |
| **Formes** | Coins arrondis généreux, cartes avec ombres douces, espacement confortable |
| **Couleurs** | Palette chaude et douce (pas de gris froid corporate). Accents de couleur vifs mais non agressifs |
| **Typographie** | Police sans-serif arrondie et lisible (ex: Inter, Plus Jakarta Sans) |
| **Avatars des Agents** | Illustrations ou icônes expressives, pas de photos stock. Chaque Agent a une identité visuelle distinctive |
| **Micro-interactions** | Animations subtiles : transitions fluides, hover doux, apparitions progressives. Rien de tape-a-l'oeil |
| **Dark mode** | Prévu dès le départ. Tons sombres chauds (pas du noir pur) |
| **Ton des messages** | Bulles de chat avec distinction claire par source (couleur, position, avatar). Lisibilité avant tout |

L'idée est que l'utilisateur se sente chez lui, pas dans un cockpit.

> **Prérequis** : avant tout développement frontend, un **design system** (palette, typographie, composants de base, spacings) et des **maquettes des écrans principaux** (onboarding, chat, sidebar, settings) doivent être produits et **validés par le porteur du projet**. Le développement UI ne démarre qu'après cette validation.

### Layout

La vue principale est divisée en deux parties :
- **Sidebar gauche** : navigation entre Agents et tâches
- **Panel principal** : interface de chat correspondant a l'élément sélectionné dans la sidebar

### Panel de chat — origines des messages

Dans la session principale d'un Agent, les messages entrants peuvent provenir de **plusieurs sources distinctes**. L'interface doit rendre l'origine de chaque message immédiatement identifiable visuellement (avatar + nom de l'envoyeur).

| Source | Affichage |
|---|---|
| **Utilisateur** | Avatar et prénom/pseudonyme de l'utilisateur |
| **Autre Agent** | Avatar et nom du Agent expéditeur |
| **Retour de tâche (sous-Agent)** | Indicateur de tâche + nom de la tâche |
| **Retour de cron** | Indicateur de cron + nom du cron |

### Sidebar

La sidebar est organisée en sections distinctes :

| Section | Contenu |
|---|---|
| **Agents** | Liste des Agents de l'utilisateur. Cliquer sur un Agent ouvre sa session principale continue |
| **Tâches** | Liste de toutes les tâches (sous-Agents) en cours, tous Agents confondus. Permet de suivre l'avancement et de consulter la session d'une tâche |

La sidebar donne également accès aux sections **Mon compte** et **Settings**.

### Mon compte

Permet de modifier les informations personnelles :
- Prénom, Nom, Pseudonyme
- Photo / Avatar
- Langue
- Mot de passe

### Settings

- Gestion des AI providers (ajout / modification / suppression)
- Gestion des search providers (ajout / modification / suppression)
- Gestion des serveurs MCP
- Gestion du **Vault** (voir section ci-dessous)

### Vault (secrets)

Le Vault est un coffre-fort centralisé permettant de stocker des secrets (clés API, tokens, mots de passe de services tiers, etc.) que les Agents peuvent consulter lors de l'exécution de leurs tâches.

| Aspect | Description |
|---|---|
| **Gestion** | L'administrateur crée, modifie et supprime les entrées du Vault via l'interface Settings |
| **Structure** | Chaque secret est une paire clé/valeur nommée (ex: `GITHUB_TOKEN`, `NOTION_API_KEY`) |
| **Stockage** | Les valeurs sont chiffrées en base de données (encryption at rest) |
| **Accès par les Agents** | Les Agents disposent d'un outil `get_secret(key)` pour récupérer un secret par sa clé. La valeur n'est jamais injectée dans le prompt système — elle est uniquement accessible via l'outil, a la demande |
| **Visibilité** | Les valeurs ne sont jamais affichées en clair dans l'interface (masquées par défaut). Les Agents ne doivent jamais inclure les valeurs de secrets dans leurs réponses visibles par l'utilisateur |
| **Caviardage** | Quand un utilisateur transmet un secret via le chat (ex: "voici mon token GitHub : ghp_xxxx"), le Agent peut le stocker dans le Vault puis **caviarder le message original** dans l'historique via un outil dédié `redact_message(message_id, redacted_text)`. Le secret est remplacé par un placeholder (ex: `[SECRET: GITHUB_TOKEN]`) dans le message stocké en DB, rendant la valeur irrécupérable depuis l'historique |
| **Priorité sur le compacting** | Le caviardage est **synchrone et prioritaire** sur le compacting. Quand le Agent détecte un secret dans un message, l'appel a `redact_message` est traité **avant** que le message puisse être inclus dans un cycle de compacting. Cela garantit qu'un secret ne se retrouve jamais dans un résumé compacté. Concrètement, un message flaggé pour caviardage est exclu du compacting tant que la redaction n'est pas effective |

---

## 3. Création du premier Agent

La création de Agent est portée par le `AgentFormModal`, accessible depuis la sidebar ou depuis l'item `create_first_agent` de la setup checklist. Deux modes :

- **Wizard** (par défaut, en mode création) : l'utilisateur décrit en langage naturel le Agent qu'il veut, et le serveur génère une config (`name`, `role`, `character`, `expertise`, modèle suggéré) via un appel LLM one-shot. Le mode Wizard est désactivé tant qu'aucun provider LLM n'est configuré (une bannière ambre l'explique, avec CTA vers Settings → Providers).
- **Manuel** (toujours disponible) : remplissage direct des champs. Une bannière ambre rappelle l'absence de provider LLM si c'est le cas, et explique que le sélecteur de modèle restera vide tant qu'aucun provider n'est ajouté.

L'avatar du Agent peut être uploadé (toujours dispo) ou généré (auto/prompt) si un provider d'image est configuré. Sinon, l'AvatarPicker affiche une bannière "No image provider configured" avec un CTA "Open Providers".

Aucune création de Agent n'est automatiquement déclenchée après l'onboarding — l'utilisateur arrive sur le dashboard avec la setup checklist et choisit son rythme.

---

## 4. Concept de Agent

Un **Agent** dans Hivekeep est une entité autonome dotée d'une identité, d'une expertise et d'outils.

**Principe fondamental** : chaque Agent ne possède qu'une **seule session principale continue**. Il n'y a pas de concept de "nouvelle conversation". Les utilisateurs parlent tous dans le même fil, et le Agent garde en permanence le contexte de ce qui a été fait récemment grâce au compacting (voir section 5). Cela garantit une continuité de contexte : le Agent sait toujours ou il en est.

**Les Agents sont partagés** entre tous les utilisateurs de la plateforme. Ils forment un **squad commun** accessible a tous. Le système multi-utilisateur permet simplement a plusieurs personnes (famille, amis) d'interagir avec les mêmes Agents. Chaque message dans la session est **tagué avec l'identité de l'utilisateur** qui l'a envoyé, afin que le Agent sache toujours a qui il s'adresse.

### Attributs configurables par l'utilisateur

| Attribut | Description |
|---|---|
| **Nom** | Nom du Agent |
| **Rôle** | Description courte de sa fonction (ex: "Expert en médecine douce") |
| **Avatar** | Image représentant le Agent. Trois modes de création : **Upload** (l'utilisateur charge une image existante), **Génération automatique** (le Agent génère son propre avatar via le provider d'images, en se basant sur son nom, rôle, caractère et expertise — prompt caché), ou **Prompt personnalisé** (l'utilisateur rédige un prompt libre envoyé au provider d'images). Nécessite un provider de génération d'image configuré pour les deux derniers modes |
| **Caractère** | Personnalité et ton du Agent (équivalent du SOUL.md d'OpenClaw) |
| **Expertise** | Objectif du Agent et ensemble des connaissances nécessaires pour répondre au mieux |
| **Modèle LLM** | Modèle utilisé par le Agent pour ses appels LLM (ex: `claude-sonnet-4-20250514`, `gpt-4o`). Doit correspondre a un modèle disponible via l'un des providers configurés |
| **Outils (MCP)** | Serveurs MCP de la plateforme auxquels le Agent a accès |

### Attributs gérés automatiquement par le Agent

#### Registre de contacts

Le Agent maintient une liste de tous les interlocuteurs qu'il rencontre. Un prompt système caché lui indique de mettre a jour ce registre de manière autonome :
- Ajouter de nouveaux contacts (avec génération d'un UUID)
- Enregistrer des faits marquants et préférences pour chaque contact

Les contacts peuvent être :
- Des **humains** : membres de la famille de l'utilisateur, amis (pouvant interagir via Telegram, Discord, WhatsApp...)
- D'autres **Agents** de la plateforme

#### Injection et consultation des contacts

Pour éviter que le prompt système n'explose avec des centaines de contacts, seul un **résumé compact** est injecté dans le prompt système : la liste des noms/pseudonymes des contacts avec leur UUID (sans les détails). Cela permet au Agent de savoir qui il connaît sans surcharger le contexte.

Pour accéder aux détails d'un contact, le Agent dispose d'outils dédiés :

| Outil | Description |
|---|---|
| `get_contact(contact_id)` | Récupère la fiche complète d'un contact (faits marquants, préférences, notes) |
| `search_contacts(query)` | Recherche dans les contacts par nom, relation ou mot-clé (ex: "frère de Nicolas", "allergique") |
| `create_contact(name, type, notes?)` | Crée un nouveau contact (humain ou Agent) |
| `update_contact(contact_id, updates)` | Met a jour les informations d'un contact |

#### Outils auto-générés

En plus des **outils MCP** assignés au Agent par l'utilisateur (voir "Attributs configurables"), l'utilisateur **et** les Agents peuvent créer de **vrais outils custom**, **globaux** et intégrés comme les outils natifs/MCP, pour étendre Hivekeep. Ils sont organisés dans des **domaines** (catégories icône/couleur/label, dont des domaines personnalisés créables) et accordés aux Agents via le système de **toolboxes**.

| Aspect | Description |
|---|---|
| **Portée** | **Globale** (platform-wide), plus de scope per-Agent. Un outil custom est exposé sous le nom `custom_<slug>` et accordé à un Agent/une tâche dès qu'une toolbox le liste (comme MCP). Le wildcard `*` couvre désormais le natif **+ tous les outils custom activés** ; les outils MCP et plugin restent à lister explicitement par nom. |
| **Création** | Via une page Settings (« Custom Tools ») **ou** par un Agent via des outils dédiés (`create_custom_tool`, `write_custom_tool_file`, `run_custom_tool_setup`, `test_custom_tool`, `update_custom_tool`, `delete_custom_tool`, `list_custom_tools`). Pas d'approbation : un outil est actif dès sa création (toggle activer/désactiver). |
| **Stockage** | Chaque outil = un dossier géré `data/custom-tools/<slug>/` (entrypoint + dépendances : `requirements.txt`/`package.json`, venv/node_modules). La DB ne stocke que les métadonnées. |
| **Langage & deps** | N'importe quel langage. `run_custom_tool_setup` installe les dépendances (pip dans un `.venv`, `bun install`). |
| **Binding runtime** | Interpréteur résolu via `language` → shebang → extension → bun. Args = objet JSON sur **stdin** (+ env `CUSTOM_TOOL_ARGS`) ; cwd = dossier de l'outil ; résultat = stdout (JSON parsé si possible) ; exit≠0 → échec ; timeout (arbre de process tué) ; sortie plafonnée. |
| **Domaines** | `create_tool_domain` / `list_tool_domains` / `update_tool_domain` / `delete_tool_domain` (UI dédiée aussi). 26 domaines built-in read-only + domaines custom. |
| **Renderer de résultat (optionnel)** | Un outil custom peut embarquer un `renderer.tsx` (composant React) qui met en forme son résultat dans la vue détaillée du tool-call ; bundlé côté serveur, chargé à la volée, auto-thémé via les tokens `--color-*`. Absent → le résultat s'affiche en JSON comme aujourd'hui. |

**Distinction MCP vs custom** : les outils MCP sont des serveurs externes configurés au niveau de la plateforme. Les outils custom sont des scripts globaux (n'importe quel langage) authored via l'UI ou les Agents, exécutés par l'hôte, et accordés via les toolboxes. **Sécurité** : un outil custom exécute du code arbitraire avec les privilèges du process Hivekeep (plateforme self-hosted) — garde-fous : toggle désactiver, sortie plafonnée, kill de l'arbre de process, accès filtré par toolbox.

#### Workspace

Chaque Agent dispose d'un dossier de travail local (avec un chemin par défaut). Il peut y cloner des repos, créer ses outils custom, télécharger des fichiers, etc.

---

## 5. Sessions et compacting

Chaque Agent possède une **session principale continue**. Contrairement a un chat classique ou chaque conversation est indépendante, la session principale d'un Agent est persistante : elle représente le fil de conscience continu du Agent.

### Compacting

Au fur et a mesure que la session principale grandit, un mécanisme de **compacting** résume les échanges anciens pour maintenir une fenêtre de contexte exploitable. Le Agent conserve ainsi une mémoire de travail synthétisée de son historique, sans perdre les informations importantes.

### Persistance des messages originaux

Le compacting ne supprime **jamais** les messages originaux de la base de données. Il génère une couche de résumé qui est injectée dans le contexte du LLM, mais les échanges bruts restent consultables :
- Par les **utilisateurs**, via l'interface (historique scrollable)
- Par le **Agent lui-même**, via un outil dédié (`search_history(query)`) qui lui permet de fouiller ses échanges passés au-delà de sa fenêtre de contexte active

### Mémoire long terme

Le compacting gère la **mémoire de travail** (résumé glissant de la conversation récente). La mémoire long terme est un mécanisme complémentaire qui **extrait et structure les connaissances durables** issues des échanges.

#### Pipeline d'extraction

Après chaque interaction (ou au moment du compacting), un **modèle léger et peu coûteux** (ex: Haiku) analyse les échanges récents et extrait les informations a retenir :

| Type de mémoire | Exemples |
|---|---|
| **Faits utilisateur** | "Nicolas est végétarien", "Marie est allergique aux arachides" |
| **Préférences** | "Nicolas préfère les résumés courts", "La famille part en vacances en août" |
| **Décisions prises** | "On a choisi Next.js pour le projet X", "Le budget mensuel courses est de 600€" |
| **Connaissances métier** | Informations spécifiques au domaine d'expertise du Agent accumulées au fil des échanges |

Chaque mémoire extraite est stockée avec :
- Un **contenu textuel** (le fait ou la connaissance)
- Un **embedding** (vecteur de représentation sémantique)
- Une **source** (référence au message ou a la session d'origine)
- Un **timestamp** de création
- Une **catégorie** (fait, préférence, décision, connaissance)
- Un **sujet** (a quel contact ou contexte se rapporte cette mémoire)

#### Restitution automatique

Au moment de construire le contexte d'un appel LLM, le système récupère les mémoires pertinentes par **recherche sémantique** (similarité cosinus sur les embeddings) en fonction du message entrant et du contexte actuel. Les mémoires les plus pertinentes sont injectées dans le prompt système.

#### Outils mémoire du Agent

Le Agent dispose d'outils dédiés pour interagir proactivement avec sa mémoire long terme :

| Outil | Description |
|---|---|
| `recall(query)` | Recherche sémantique dans la mémoire. Retourne les mémoires les plus pertinentes par rapport a la requête |
| `memorize(content, category, subject)` | Enregistre explicitement une mémoire (sans attendre le pipeline automatique). Utile quand le Agent identifie une information importante a retenir immédiatement |
| `update_memory(memory_id, new_content)` | Met a jour une mémoire existante (ex: correction, information actualisée) |
| `forget(memory_id)` | Supprime une mémoire devenue obsolète ou incorrecte |
| `list_memories(subject?, category?)` | Liste les mémoires, filtrable par sujet ou catégorie |

Cela permet au Agent de **gérer activement ses connaissances** : mémoriser un fait important sur le moment, corriger une information devenue fausse, ou nettoyer des mémoires obsolètes.

#### Cycle de vie des mémoires

Les mémoires sont alimentées par **deux canaux** :

| Canal | Description |
|---|---|
| **Automatique** | Le pipeline d'extraction analyse les échanges et crée/met a jour des mémoires en arrière-plan |
| **Explicite** | Le Agent utilise ses outils (`memorize`, `update_memory`, `forget`) pour gérer ses mémoires proactivement |

L'utilisateur peut également consulter et supprimer des mémoires via l'interface du Agent (section Settings du Agent).

#### Stockage et recherche hybride

La recherche dans la mémoire long terme utilise une **approche hybride** combinant deux moteurs :

| Moteur | Technologie | Usage |
|---|---|---|
| **Recherche sémantique** | sqlite-vec (KNN sur embeddings) | Trouver des mémoires par proximité de sens, même si les mots diffèrent (ex: "régime alimentaire" retrouve "Nicolas est végétarien") |
| **Recherche textuelle** | SQLite FTS5 (full-text search) | Trouver des mémoires par correspondance exacte de mots-clés (ex: "Next.js" retrouve la décision sur le choix de framework) |

Les deux moteurs sont interrogés en parallèle et les résultats sont fusionnés (rank fusion) pour maximiser la pertinence. La recherche sémantique excelle pour les requêtes vagues ou reformulées, tandis que FTS5 est imbattable pour les termes précis (noms propres, noms techniques, identifiants).

Cette approche s'applique également a `search_history(query)` pour la recherche dans l'historique des messages.

### Purge et rollback

Si le contexte compacté devient incohérent (hallucinations accumulées, mauvais résumé), l'utilisateur peut :
- **Purger le compacting** : réinitialiser le résumé compacté, forçant le Agent a repartir d'un contexte vierge (les messages originaux restent en DB)
- **Rollback** : revenir a un état compacté antérieur (les snapshots de compacting sont conservés)

### Queue de traitement

Chaque Agent possède une **queue FIFO** qui sérialise le traitement de tous les messages entrants. Un Agent ne traite qu'**un seul message a la fois** : tant qu'il n'a pas terminé de répondre au message courant, les messages suivants restent en attente dans la queue.

#### Pourquoi ?

La session principale est un contexte partagé unique. Si deux messages étaient traités en parallèle (ex: un utilisateur et un cron au même moment), le Agent produirait deux réponses basées sur le même état du contexte, créant des incohérences dans l'historique.

#### Sources de messages enqueués

Toutes les sources convergent vers la même queue :

| Source | Exemple |
|---|---|
| **Utilisateur** | Message envoyé via l'interface de chat |
| **Autre Agent** | Message inter-Agents (`request` ou `inform`) |
| **Sous-Agent (mode `await`)** | Résultat d'une tâche via `report_to_parent`. **Déclenche un tour de traitement LLM** sur le Agent parent, qui peut ainsi exploiter le résultat et poursuivre son travail |

> **Note** : les résultats de crons et de sous-Agents en mode `async` ne passent pas par la queue. Ils sont déposés directement dans l'historique comme messages informatifs sans déclencher de traitement LLM. Seuls les sous-Agents en mode `await` entrent dans la queue, car le Agent parent attend le résultat pour continuer son travail (voir sections 7 et 8).

#### Priorité

Les messages **utilisateur** sont prioritaires sur les messages automatiques (inter-Agents, tâches). Si un utilisateur envoie un message alors que la queue contient déjà des messages automatiques en attente, son message est inséré **en tête de queue** (après le message en cours de traitement).

#### Feedback UI

| Situation | Comportement |
|---|---|
| **Agent en cours de traitement** | L'interface affiche un indicateur de traitement en cours (typing indicator) |
| **Messages en attente** | Un badge sur le Agent dans la sidebar indique le nombre de messages en queue |
| **Message utilisateur enqueué** | L'utilisateur voit son message affiché dans le chat avec un statut "en attente de traitement" jusqu'a ce que le Agent le prenne en charge |

---

## 6. Communication inter-Agents

Les Agents disposent d'outils natifs pour communiquer entre eux au sein de la plateforme.

### Messagerie directe

Un Agent peut envoyer un message a un autre Agent de la plateforme. Le message est déposé dans la queue FIFO du Agent destinataire, qui le traite a son tour.

Outils disponibles :

| Outil | Description |
|---|---|
| `send_message(agent_id, message, type)` | Envoie un message a un Agent cible. `type` est `request` (réponse attendue) ou `inform` (informatif, pas de réponse attendue). Si `type` est `request`, le système génère un `request_id` unique retourné a l'expéditeur |
| `reply(request_id, message)` | Répond a un `request` reçu. La réponse est déposée dans la queue FIFO du Agent demandeur, **corrélée au request original** via le `request_id`. La réponse est toujours de type `inform` — elle ne déclenche jamais de réponse automatique du destinataire |
| `list_kins()` | Liste les Agents disponibles sur la plateforme |

Cela permet la collaboration entre Agents sans intervention humaine (ex: un Agent "Recherche" qui transmet ses résultats a un Agent "Rédaction").

### Flux d'un échange inter-Agents (request/reply)

```
1. Agent A appelle send_message(agent_B, "Recherche les prix des vols pour Rome", "request")
   → le système génère request_id: "req_abc123"
   → le message entre dans la queue FIFO de Agent B (type: request, request_id: req_abc123, from: Agent A)
   → Agent A reçoit le request_id pour référence

2. Agent B traite le message, voit que c'est un request de Agent A
   → Agent B effectue son travail...
   → Agent B appelle reply("req_abc123", "Voici les 3 meilleurs vols...")
   → la réponse entre dans la queue FIFO de Agent A (type: inform, in_reply_to: req_abc123)

3. Agent A traite la réponse et peut la corréler a sa demande originale grâce au request_id
```

La réponse via `reply` est **toujours de type `inform`**, ce qui garantit par design qu'elle ne déclenche pas de réponse automatique en retour. Pas de ping-pong possible.

### Garde-fous

Pour éviter les boucles infinies de messages entre Agents (A envoie a B, B répond a A, A réagit, etc.) :

| Mécanisme | Description |
|---|---|
| **Type de message** | Chaque message inter-Agents porte un type : `request` (réponse attendue) ou `inform` (informatif, pas de réponse attendue). Un message `inform` ne déclenche pas de réponse automatique. Les réponses via `reply` sont toujours `inform` |
| **Corrélation** | Chaque `request` porte un `request_id` unique. La réponse via `reply(request_id, message)` est corrélée au request original, permettant au Agent demandeur de faire le lien entre sa question et la réponse reçue |
| **Rate limiting** | Limite du nombre de messages qu'un Agent peut envoyer a un autre Agent dans une fenêtre de temps donnée |
| **Compteur de profondeur** | Chaque chaîne de messages inter-Agents porte un compteur incrémenté a chaque échange. Au-delà d'un seuil configurable, la chaîne est interrompue |

---

## 7. Spawning de sous-Agents (Tâches)

Un Agent peut **spawner un sous-Agent** pour déléguer une tâche temporaire. Le sous-Agent est une instance éphémère créée dans un but précis, qui disparaît une fois la tâche terminée.

### Deux modes de spawning

| Mode | Description |
|---|---|
| **Clone de soi-même** | Le Agent crée une copie de lui-même (même caractère, même expertise) dédiée a une sous-tâche spécifique |
| **Spawn d'un autre Agent** | Le Agent instancie un autre Agent de la plateforme pour lui confier une tâche qui relève de l'expertise de cet autre Agent |

### Cycle de vie d'une tâche

Une tâche (sous-Agent) possède un **état** qui évolue au cours de son exécution :

```
pending → in_progress → completed
                      → failed
                      → cancelled
```

### Outils du sous-Agent

Le sous-Agent dispose d'outils pour interagir avec sa session parente :

| Outil | Description |
|---|---|
| `report_to_parent(message)` | Envoie un message / un résultat intermédiaire a la session parente |
| `update_task_status(status)` | Met a jour l'état de la tâche (`in_progress`, `completed`, `failed`) |
| `request_input(question)` | Demande une clarification ou une décision au Agent parent. La question est déposée dans la queue FIFO du parent et **déclenche un tour LLM** pour qu'il puisse répondre via `respond_to_task`. Limité a **3 appels par sous-Agent** pour éviter un ping-pong interminable — au-delà, le sous-Agent doit avancer avec ce qu'il a ou échouer |

### Outils du Agent parent

Le Agent parent dispose d'outils pour gérer ses sous-Agents :

| Outil | Description |
|---|---|
| `spawn_self(task_description, mode, model?)` | Clone de soi-même avec une mission spécifique. Si `model` est omis, le sous-Agent hérite du modèle du parent |
| `spawn_agent(agent_id, task_description, mode, model?)` | Instancie un autre Agent avec une mission spécifique. Si `model` est omis, le sous-Agent hérite du modèle du Agent cible |
| `respond_to_task(task_id, answer)` | Répond a une demande de clarification d'un sous-Agent (`request_input`). La réponse est injectée dans la session du sous-Agent et déclenche la reprise de son traitement |
| `cancel_task(task_id)` | Annule une tâche en cours |
| `list_tasks({ status?, parent_agent_slug?, child_agent_slug?, kind?, since?, until?, limit?, offset? })` | Liste paginée des tâches liées au Agent (spawnées ou assignées). Renvoie des résumés légers (id, title, status, kind, slugs, timing, duration_ms). Sans description ni payload de message. Defaults: `limit=20`, `offset=0`. Max `limit=100` |
| `get_task_detail(task_id)` | Détail complet d'une tâche unique (description, result, error, mode, et historique complet des messages) |
| `get_task_messages(task_id, { limit?, offset?, order? })` | Vue paginée des messages d'une tâche, avec previews (200 chars), longueur, et compte des tool calls. Defaults: `limit=20`, `offset=0`, `order='desc'`. `offset` négatif (ex `-20`) renvoie les N derniers messages |

### Choisir le bon outil de lecture de tâches

Trois outils, trois cas d'usage :

| Cas | Outil | Pourquoi |
|---|---|---|
| Trouver / naviguer parmi les tâches | `list_tasks` | Payload léger par défaut (20 entrées, pas de description ni de result), permet de filtrer par status / kind / slug / fenêtre temporelle |
| Lire le détail complet d'une tâche connue | `get_task_detail` | Renvoie description, result, error, mode, et l'historique complet des messages. Attention au volume si la tâche est longue |
| Inspecter l'historique d'une tâche longue page par page | `get_task_messages` | Renvoie des previews de 200 chars + métadonnées (longueur, tool calls). Conçu pour éviter le context spill |

Exemples typiques :

```text
# Les 20 dernières tâches échouées
list_tasks({ status: 'failed' })

# Les derniers runs d'un cron, sur les 7 derniers jours
list_tasks({ kind: 'cron', since: '2026-05-06T00:00:00Z' })

# Toutes les tâches qu'un Agent enfant a exécutées pour moi
list_tasks({ child_agent_slug: 'researcher-ai', status: 'completed' })

# Drill into a single task without loading its full history
get_task_messages(task_id, { limit: 10, offset: -10 })  # 10 derniers messages
get_task_messages(task_id, { limit: 50, order: 'asc' }) # 50 premiers messages
```

### Modes de spawning

Le paramètre `mode` détermine le comportement du Agent parent après le spawn :

| Mode | Comportement |
|---|---|
| **`await`** | Le Agent parent **attend le résultat** du sous-Agent avant de reprendre. Son tour de traitement se termine, et quand le sous-Agent complète sa tâche, le résultat entre dans la queue FIFO et **déclenche un tour LLM** pour que le parent puisse exploiter le résultat et poursuivre son travail. Utile quand le résultat est nécessaire pour continuer (ex: "recherche ces infos, j'en ai besoin pour rédiger la suite") |
| **`async`** | Le Agent parent **continue a travailler** sans attendre. Le résultat du sous-Agent est déposé dans la session principale comme message informatif (comme un cron), **sans déclencher de traitement LLM**. Le Agent verra le résultat dans son contexte au prochain échange naturel. Utile pour les tâches parallèles indépendantes (ex: "génère cette image pendant que je continue a discuter") |

Le mode par défaut est **`await`**, car dans la majorité des cas le Agent a besoin du résultat pour poursuivre.

### Flux de clarification (`request_input`)

Quand un sous-Agent a besoin d'une clarification du parent, le flux est le suivant :

```
1. Parent spawne sous-Agent (mode await) → tour LLM parent TERMINE
2. Sous-Agent travaille...
3. Sous-Agent appelle request_input(question)
   → la question entre dans la queue FIFO du parent (type: task_input)
   → déclenche un nouveau tour LLM sur le parent
4. Parent voit la question, appelle respond_to_task(task_id, answer)
   → la réponse est injectée dans la session du sous-Agent
   → déclenche la reprise du sous-Agent
5. Sous-Agent termine → report_to_parent(result)
   → entre dans la queue FIFO du parent
   → déclenche un nouveau tour LLM sur le parent
```

Il n'y a **aucun deadlock** car personne n'est bloqué dans un thread : ce sont des tours LLM successifs déclenchés par des messages dans la queue. Le parent ne "bloque" pas en attendant — son tour se termine simplement, et un nouveau tour est déclenché quand un message arrive.

> **Garde-fou** : le nombre de `request_input` par sous-Agent est limité (par défaut : 3). Au-delà, le sous-Agent doit avancer avec les informations dont il dispose ou passer en état `failed`.

### Profondeur maximale

Le spawning est limité en profondeur : un sous-Agent **ne peut pas spawner de sous-Agents au-delà d'une profondeur configurable** (par défaut : 3 niveaux). Cela empêche les chaînes de délégation récursives incontrôlées.

### Résolution

Quand un sous-Agent termine sa tâche, il passe son état a `completed` et envoie son résultat final a la session parente via `report_to_parent`. Le comportement dépend du mode de spawning :
- **`await`** : le résultat entre dans la queue FIFO et déclenche un tour de traitement LLM sur le parent
- **`async`** : le résultat est déposé dans l'historique comme message informatif, sans déclencher de traitement

Le sous-Agent est ensuite détruit.

---

## 8. Tâches planifiées (Crons)

Les Agents peuvent exécuter des tâches de manière récurrente grâce a un système de **crons**. Un cron déclenche le spawn d'un sous-Agent a intervalle régulier, avec une mission définie. Le sous-Agent exécute sa tâche puis renvoie son résultat dans la session principale du Agent, exactement comme un sous-Agent classique (voir section 7).

### Qui peut créer un cron ?

| Source | Description |
|---|---|
| **L'utilisateur** | Via l'interface, il peut planifier une tâche récurrente sur un Agent |
| **Le Agent lui-même** | Via ses outils, il peut proposer la création d'une tâche récurrente. **En V1, la création nécessite une confirmation de l'utilisateur** avant d'être activée |

### Définition d'un cron

| Attribut | Description |
|---|---|
| **Nom** | Libellé de la tâche planifiée |
| **Expression cron** | Planification au format cron (ex: `0 9 * * *` pour tous les jours a 9h) |
| **Description de la tâche** | Instructions données au sous-Agent a chaque exécution |
| **Agent cible** | Le Agent sur lequel le cron s'exécute (par défaut : soi-même) |
| **Modèle LLM** | Modèle utilisé par le sous-Agent du cron. Si non spécifié, hérite du modèle du Agent cible |
| **Actif / Inactif** | Permet de suspendre un cron sans le supprimer |

### Outils du Agent pour gérer ses crons

| Outil | Description |
|---|---|
| `create_cron(name, schedule, task_description)` | Crée une nouvelle tâche planifiée |
| `update_cron(cron_id, ...)` | Modifie un cron existant (planification, description, état) |
| `delete_cron(cron_id)` | Supprime un cron |
| `list_crons()` | Liste ses tâches planifiées et leur état |

### Exécution

A chaque déclenchement, le système spawn un sous-Agent éphémère avec la description de la tâche du cron. Ce sous-Agent suit le même cycle de vie qu'une tâche classique (`pending → in_progress → completed/failed`).

### Restitution du résultat

Le résultat d'un cron est **déposé dans la session principale** du Agent comme un message informatif, mais **ne déclenche pas de tour de traitement LLM** sur l'agent principal. Contrairement a un message utilisateur ou inter-Agents qui entre dans la queue FIFO et nécessite une réponse, le résultat du cron est simplement ajouté a l'historique.

| Aspect | Comportement |
|---|---|
| **Visibilité** | Le résultat apparaît dans le chat (visible par l'utilisateur et par le Agent) |
| **Contexte** | Le Agent verra le résultat dans son contexte au prochain échange naturel (message utilisateur, message inter-Agents, etc.) |
| **Pas de blocage** | Le résultat ne passe pas par la queue FIFO et ne déclenche pas d'appel LLM. L'agent principal reste disponible |
| **Action si nécessaire** | Si le résultat du cron nécessite une action (ex: alerte), c'est au sous-Agent du cron de la prendre (envoyer une notification, un message inter-Agents, etc.) avant de terminer |

---

## 9. Stack technique

Architecture monolithique en un seul process, conçue pour un déploiement simple (un seul `docker run`).

### Backend

| Brique | Technologie | Rôle |
|---|---|---|
| **Runtime** | Bun | Runtime TypeScript natif, performant, SQLite intégré |
| **Framework HTTP** | Hono | API REST + SSE, léger, type-safe, middleware simple |
| **Base de données** | SQLite (via `bun:sqlite`) | Persistance en un seul fichier, zéro dépendance externe |
| **Recherche vectorielle** | sqlite-vec | Extension SQLite pour la recherche KNN sur les embeddings (mémoire long terme) |
| **Recherche textuelle** | SQLite FTS5 | Full-text search natif pour la recherche hybride (mémoire + historique) |
| **ORM** | Drizzle | Type-safe, migrations, requêtes proches du SQL |
| **LLM** | Primitives natives (`src/server/llm/llm/`) | Orchestration multi-provider (Anthropic, OpenAI, Gemini, OpenRouter, xAI, DeepSeek, MiniMax, Kimi), streaming, tool calling |
| **Embeddings** | Primitives natives (`src/server/llm/embedding/`) | Génération d'embeddings (OpenAI) pour la mémoire long terme |
| **Auth** | Better Auth | Multi-user, sessions, compatible SQLite/Drizzle |
| **Crons** | croner | Scheduler in-process, pas besoin de Redis |
| **Real-time** | SSE (via Hono) | Streaming des réponses LLM et mises a jour des tâches |

### Frontend

| Brique | Technologie | Rôle |
|---|---|---|
| **Framework** | React | Composants UI, gestion d'état |
| **Bundler** | Vite | Dev server rapide, HMR, build optimisé |
| **Styling** | Tailwind CSS | Utility-first, rapide a prototyper |
| **Composants** | shadcn/ui | Composants accessibles et personnalisables, basés sur Radix UI |
| **AI Client** | Client SSE natif (`src/client/hooks/`) | Hooks React maison pour le streaming LLM via SSE |

### Vue d'ensemble

```
Hivekeep
├── Frontend (React + Vite + Tailwind + shadcn/ui)
│   └── Client SSE natif (hooks React maison)
│
└── Backend (Bun + Hono)
    ├── Drizzle + SQLite (persistance)
    ├── Primitives LLM natives (orchestration multi-provider, src/server/llm/*)
    ├── Better Auth (authentification)
    └── croner (tâches planifiées)
```

**Principe** : zéro dépendance d'infrastructure externe. Un seul process, un seul fichier DB, un seul conteneur Docker.

> **Documentation technique** :
> - [schema.md](schema.md) — Schéma détaillé de la base de données SQLite
> - [structure.md](structure.md) — Arborescence du projet et conventions
> - [prompt-system.md](prompt-system.md) — Construction du prompt système des Agents
> - [config.md](config.md) — Configuration centralisée et valeurs par défaut
> - [api.md](api.md) — Contrats API REST et SSE (request/response)
> - [compacting.md](compacting.md) — Algorithme de compacting et extraction de mémoires

---

## 10. Communication Frontend / Backend

### Approche hybride : REST + SSE

La communication entre le frontend et le backend repose sur deux canaux complémentaires :

| Canal | Usage | Direction |
|---|---|---|
| **API REST** | CRUD, actions utilisateur, envoi de messages | Client → Serveur |
| **SSE** (Server-Sent Events) | Streaming LLM, mises a jour de tâches, notifications | Serveur → Client |

### API REST

Toutes les opérations classiques passent par une API REST :

| Domaine | Exemples de routes |
|---|---|
| **Auth** | `POST /api/auth/login`, `POST /api/auth/register`, `POST /api/auth/logout` |
| **Compte** | `GET /api/me`, `PATCH /api/me` |
| **Agents** | `GET /api/agents`, `POST /api/agents`, `PATCH /api/agents/:id`, `DELETE /api/agents/:id` |
| **Chat** | `POST /api/agents/:id/messages` (envoie un message, déclenche le streaming SSE en réponse) |
| **Providers** | `GET /api/providers`, `POST /api/providers`, `PATCH /api/providers/:id` |
| **Tâches** | `GET /api/tasks`, `GET /api/tasks/:id` |
| **Crons** | `GET /api/crons`, `POST /api/crons`, `PATCH /api/crons/:id`, `DELETE /api/crons/:id` |
| **MCP** | `GET /api/mcp-servers`, `POST /api/mcp-servers` |

### SSE (Server-Sent Events)

Le SSE est utilisé pour tout ce qui est poussé du serveur vers le client en temps réel :

| Canal SSE | Contenu |
|---|---|
| **Chat stream** | Tokens du LLM en streaming lors d'une réponse du Agent (via les primitives LLM natives) |
| **Événements** | Changement d'état d'une tâche, résultat d'un sous-Agent, exécution d'un cron, message inter-Agents |

Le frontend maintient une connexion SSE persistante par session active. Des hooks React maison gèrent le streaming SSE côté client.

### Pourquoi pas WebSocket ?

- Le seul flux bidirectionnel est "user envoie un message / serveur stream la réponse", et REST + SSE couvre ça parfaitement
- SSE est plus simple a implémenter, débugger et maintenir (HTTP standard, reconnexion automatique native)
- Better Auth et les primitives LLM natives fonctionnent nativement en REST + SSE
- Pas de protocole custom a gérer

---

## 11. Authentification

### Mécanisme

L'authentification est gérée par **Better Auth** avec des sessions côté serveur stockées en SQLite.

| Aspect | Choix |
|---|---|
| **Méthode** | Email + mot de passe |
| **Sessions** | Côté serveur (stockées en DB via Drizzle) |
| **Token** | Cookie HTTP-only sécurisé |
| **Middleware** | Hono middleware qui vérifie la session sur chaque requête API |

### Flux

1. L'utilisateur se connecte via `POST /api/auth/login`
2. Better Auth crée une session en DB et renvoie un cookie HTTP-only
3. Chaque requête API et connexion SSE inclut automatiquement le cookie
4. Le middleware Hono valide la session avant de traiter la requête

### Multi-utilisateur

- Le premier utilisateur créé lors de l'onboarding est **administrateur**
- Les utilisateurs suivants peuvent être invités par l'administrateur
- **Les Agents sont partagés** entre tous les utilisateurs. Il n'y a pas de Agents "privés" : tous les utilisateurs accèdent au même squad de Agents
- Le système multi-utilisateur permet aux Agents de **reconnaître qui leur parle** (chaque message est tagué avec l'identité de l'utilisateur)
- L'administrateur gère les comptes utilisateurs et la configuration globale (providers, serveurs MCP)

---

## 12. Aspects opérationnels

### Upload de fichiers

Les utilisateurs peuvent envoyer des fichiers (images, PDF, documents) au Agent via l'interface de chat, de manière classique. Les fichiers sont stockés localement et référencés dans la session.

### Gestion des erreurs LLM

| Contexte | Comportement |
|---|---|
| **Dans une tâche (sous-Agent)** | La tâche passe en état `failed` avec le détail de l'erreur. Le Agent parent est notifié via `report_to_parent` |
| **Dans un agent principal** | Un **warning visuel** est affiché sur le Agent dans la sidebar, et un message d'erreur apparaît dans le chat pour informer l'utilisateur |

Les erreurs gérées incluent : rate limits du provider, timeouts, provider indisponible, réponse malformée.

### Limites de concurrence

| Ressource | Limite |
|---|---|
| **Agents principaux (Agents)** | Pas de limite — tous les Agents peuvent être actifs simultanément |
| **Tâches (sous-Agents)** | Limite configurable du nombre de tâches concurrentes (tous Agents confondus) |
| **Crons** | Limite configurable du nombre de crons actifs et du nombre d'exécutions concurrentes |

La seule contrainte sur les agents principaux est le rate limit du provider LLM.

---

## 13. Architecture extensible

L'architecture de Hivekeep est conçue dès le départ pour être **pluggable**, **hookable** et **observable**, afin de faciliter l'ajout futur d'un système de plugins.

### Interfaces standardisées (Providers)

Chaque type de service externe est abstrait derrière une interface TypeScript standard. Les implémentations concrètes sont interchangeables.

#### Architecture : configuration unique, capacités multiples

Un même provider (ex: OpenAI) peut offrir plusieurs capacités (LLM, embeddings, images). Pour éviter de configurer la même API key plusieurs fois, l'architecture sépare la **configuration du provider** de ses **capacités** :

```typescript
// Configuration unique du provider (une seule API key)
interface ProviderConfig {
  id: string
  name: string
  type: 'anthropic' | 'openai' | 'gemini' | 'brave-search' | string
  config: Record<string, unknown>  // API key, base URL, etc.

  // Validation
  validateConfig(): Promise<boolean>
  testConnection(): Promise<boolean>

  // Capacités exposées par ce provider
  capabilities: ProviderCapability[]  // ['llm', 'embedding', 'image', 'search']
}

type ProviderCapability = 'llm' | 'embedding' | 'image' | 'search'
```

A partir d'un `ProviderConfig`, le système instancie les interfaces de capacité correspondantes. L'utilisateur configure un provider **une seule fois** (ex: "OpenAI" avec sa clé API), et la plateforme détecte automatiquement les capacités disponibles ou l'utilisateur les active manuellement.

#### AI Providers

| Provider | Capacités |
|---|---|
| **Anthropic** | `llm` (clé API + OAuth Claude Max) |
| **OpenAI** | `llm`, `embedding`, `image`, `tts`, `stt` (clé API + Codex CLI) |
| **Gemini** | `llm`, `image` |
| **OpenRouter / xAI / DeepSeek / MiniMax / Kimi** | `llm` |
| **Voyage AI** | `embedding` |

#### Search Providers

| Provider | Capacités |
|---|---|
| **Brave Search** | `search` |

#### LLM Capability

```typescript
interface LLMCapability {
  // Complétion
  chat(params: ChatParams): AsyncIterable<ChatStreamEvent>

  // Capacités
  supportsTools(): boolean
  supportsVision(): boolean
  listModels(): Promise<Model[]>
}
```

#### Embedding Capability

```typescript
interface EmbeddingCapability {
  // Génération d'embeddings
  embed(params: EmbedParams): Promise<number[][]>

  // Modèles disponibles
  listModels(): Promise<EmbeddingModel[]>
}
```

#### Image Capability

```typescript
interface ImageCapability {
  // Génération d'image
  generate(params: ImageGenerationParams): Promise<GeneratedImage>
}
```

#### Search Capability

```typescript
interface SearchCapability {
  // Recherche web
  search(params: SearchParams): Promise<SearchResult[]>
}

interface SearchParams {
  query: string
  count?: number     // nombre de résultats (défaut: 5)
  freshness?: string // filtre de fraîcheur (ex: "day", "week", "month")
}

interface SearchResult {
  title: string
  url: string
  description: string
  age?: string
}
```

Quand un Agent a besoin d'un appel LLM, le système résout quel `ProviderConfig` utiliser a partir du modèle configuré sur le Agent. Quand le pipeline de mémoire a besoin d'embeddings, il utilise le `ProviderConfig` qui expose la capacité `embedding`. Même logique pour la génération d'images et la recherche web.

Ces interfaces permettent d'ajouter de nouveaux providers (Mistral, Groq, local/Ollama...) sans modifier le code existant.

### Event Bus

Un bus d'événements central permet a n'importe quelle partie du système d'émettre et d'écouter des événements. C'est le socle de l'observabilité et du futur système de plugins.

```typescript
interface EventBus {
  emit(event: HivekeepEvent): void
  on(eventType: string, handler: EventHandler): Unsubscribe
}
```

Événements émis par le système :

| Catégorie | Événements |
|---|---|
| **Agent** | `agent.created`, `agent.deleted`, `agent.message.received`, `agent.message.sent` |
| **Tâche** | `task.spawned`, `task.status.changed`, `task.completed`, `task.failed` |
| **Cron** | `cron.created`, `cron.triggered`, `cron.execution.completed` |
| **Contact** | `contact.created`, `contact.updated` |
| **Auth** | `user.login`, `user.logout`, `user.created` |
| **Provider** | `provider.added`, `provider.removed`, `provider.error` |

### Hooks

Des points d'accroche définis a des moments clés du cycle de vie permettent d'intercepter ou d'enrichir le comportement par défaut :

| Hook | Moment | Usage possible |
|---|---|---|
| `beforeChat` | Avant l'envoi au LLM | Modifier le prompt, ajouter du contexte, filtrer |
| `afterChat` | Après la réponse du LLM | Logger, post-traiter, déclencher des actions |
| `beforeToolCall` | Avant l'exécution d'un outil | Validation, rate limiting, audit |
| `afterToolCall` | Après l'exécution d'un outil | Logger le résultat, déclencher des side effects |
| `beforeCompacting` | Avant le compacting d'une session | Extraire des infos a sauvegarder |
| `afterCompacting` | Après le compacting | Vérifier la qualité du résumé |
| `onTaskSpawn` | Au spawn d'un sous-Agent | Appliquer des limites, logger |
| `onCronTrigger` | Au déclenchement d'un cron | Conditionner l'exécution |

### Préparation au système de plugins

Ces trois piliers (interfaces, event bus, hooks) sont les fondations du futur système de plugins. Un plugin pourra :
- Enregistrer un nouveau type de provider (LLM, image, ou autre)
- Écouter des événements via l'event bus
- S'accrocher aux hooks pour modifier le comportement
- Exposer de nouveaux outils MCP aux Agents
- Ajouter des routes API et des composants UI

---

## 14. Navigation web stateful

Au-delà des outils one-shot historiques (`browse_url`, `extract_links`, `screenshot_url`, `http_request`) qui font une requête isolée, Hivekeep fournit une famille de **14 outils `browser_*`** qui opèrent sur une **session de navigateur persistante par Agent**. Pile sous-jacente : Playwright + Chromium, avec stealth plugin (`playwright-extra` + `puppeteer-extra-plugin-stealth`).

### Cas d'usage

- **Login + scraping authentifié** : se connecter une fois (ou injecter des cookies déjà valides), puis naviguer, lire, soumettre des formulaires en restant authentifié sur plusieurs tours LLM
- **Workflows multi-étapes** : remplir un formulaire en 3 pages, valider une commande, naviguer un dashboard
- **Interaction avec des SPAs** : cliquer, taper, attendre des transitions React/Vue/Angular
- **Resolution de captcha en HITL** : voir `browser_request_human` plus bas

### Tools disponibles

Tous opt-in par Agent via `tool_config.enabledOptInTools` (jamais activés par défaut).

| Tool | Rôle |
|---|---|
| `browser_open_session` | Ouvre une session, optionnellement avec une URL de départ et une injection de cookies |
| `browser_close_session` | Ferme la session et libère les ressources |
| `browser_list_sessions` | Liste les sessions actives du Agent |
| `browser_navigate` | Va à une URL dans la session |
| `browser_click` / `browser_type` / `browser_select` / `browser_press_key` | Actions sur des éléments référencés via le snapshot |
| `browser_scroll` / `browser_wait_for` | Navigation passive (scroll, attente de condition) |
| `browser_screenshot` | Capture la page et sauve en fichier shareable |
| `browser_set_cookies` / `browser_get_cookies` / `browser_clear_cookies` | Gestion des cookies de la session |
| `browser_request_human` | Pause + screenshot + bouton continuer (pour captcha / blocage visuel) |

### Identification des éléments — accessibility snapshot

Plutôt que d'imposer au LLM de générer des sélecteurs CSS fragiles, chaque action retourne un **`page_state`** en YAML qui liste les éléments interactables avec une référence stable du type `e1`, `e2`, etc. :

```yaml
url: https://example.com/login
title: Login
elements:
  - ref: e1
    role: textbox
    name: "Email"
  - ref: e2
    role: textbox
    name: "Password"
  - ref: e3
    role: button
    name: "Sign in"
```

Le Agent appelle ensuite `browser_click({ ref: "e3" })`. En interne, on tagge les éléments via un attribut `data-kbref="eN"` injecté côté navigateur, et on résout les références via le sélecteur `[data-kbref="eN"]`. Le pattern est inspiré de Playwright MCP (Microsoft) et browser-use, et donne des résultats beaucoup plus robustes qu'un sélecteur CSS hallucinable.

### Cookies — accès authentifié sans login

`browser_open_session` et `browser_set_cookies` acceptent au choix :

- Un **tableau JSON** de cookies (format Playwright/Puppeteer) : `[{ name, value, domain, path?, expires?, httpOnly?, secure?, sameSite? }, ...]`
- Une **header string** (`name1=v1; name2=v2; ...`) avec un `default_cookie_domain` requis

Pattern typique : l'utilisateur se logge dans son propre navigateur, exporte les cookies via une extension type "Cookie Editor", les colle dans le chat → le Agent ouvre une session pré-loadée et arrive directement authentifié.

### Persistence inter-sessions — reprendre un travail commencé

Une session navigateur est éphémère par nature : une fois fermée (idle GC, fin de task, redémarrage serveur), tout son état est perdu. Pour garder une authentification, un panier en cours, des préférences localStorage, etc. d'une session à l'autre, le Agent peut **sauvegarder l'état complet** sous un nom et le **recharger** plus tard :

| Tool | Rôle |
|---|---|
| `browser_save_state({ session_id, name, description? })` | Capture cookies + localStorage + sessionStorage + origin storage de la session courante et le stocke sous un nom (ex: `"github-marlburrow"`, `"my-bank"`) |
| `browser_list_states()` | Liste les états sauvegardés du Agent (nom, date, URL d'origine, description, taille) — sans le contenu pour ne pas exposer les tokens |
| `browser_delete_state({ name })` | Supprime un état sauvegardé |
| `browser_open_session({ load_state: name, ... })` | Pré-charge un état avant la première navigation |

**Storage** : les fichiers JSON vivent dans `data/browser-states/{agentId}/{name}.json`, **hors du workspace du Agent**. Cela évite que les filesystem tools du Agent (`read_file`, `grep`, etc.) puissent accidentellement leur accéder et fuiter des cookies de session. Le seul accès est via la famille `browser_*_state`. Permission `0o600` sur les fichiers.

**Use cases** :
- Login automatique : « connecte-toi à mon GitHub avec ces credentials » → save_state → la prochaine fois, juste `load_state: "github"`
- Reprise de travail multi-tours : un sub-Agent remplit un long formulaire en plusieurs étapes, sauve l'état avant de rendre la main, le main Agent pourra reprendre le formulaire au prochain spawn
- Sessions partagées entre tasks d'un même Agent : la task d'aujourd'hui save l'état, celle de demain (cron) la recharge

**Limites configurables** : 20 états max par Agent, 5 Mo max par état, durée illimitée (le Agent gère sa propre rétention via `delete_state`).

**Suppression du Agent** : `deleteAgent` purge automatiquement le dossier d'états du Agent.

### Lifecycle et garde-fous

- **1 session active max par Agent** par défaut, configurable via `BROWSER_MAX_SESSIONS_PER_KIN`
- **5 sessions actives globales** par défaut, configurable via `BROWSER_MAX_TOTAL_SESSIONS`
- **Idle GC** après 10 min sans appel
- **TTL absolu** de 1 h depuis l'ouverture
- **Auto-close** à la fin d'une task (`resolveTask`), à la suppression d'un Agent (`deleteAgent`), au SIGTERM/SIGINT du serveur

Tous configurables via env vars (`BROWSER_SESSION_TTL_MS`, `BROWSER_SESSION_IDLE_TIMEOUT_MS`, etc.). Voir `config.md` pour la liste complète.

### Human-in-the-loop — `browser_request_human`

Quand un Agent se heurte à un captcha ou un blocage visuel qu'il ne peut pas résoudre programmatiquement, il appelle `browser_request_human({ session_id, reason })`. Le tool :

1. Capture un screenshot full-page
2. Sauve le PNG via le file storage (URL shareable)
3. Crée un human prompt avec le screenshot embarqué inline (markdown image dans la `description`)
4. La task passe en `awaiting_human_input` et l'UI affiche la carte avec deux boutons (continuer / annuler)

L'utilisateur résout le blocage externalement (par exemple en exportant ses cookies puis en les ré-injectant via `browser_set_cookies`), puis clique « C'est résolu ». La task reprend avec la réponse injectée dans l'historique du Agent.

L'implémentation **réutilise entièrement** l'infra `humanPrompts` existante : pas de nouveau type de prompt, pas de migration DB, pas de composant UI dédié. Le rendu est universel grâce au support du markdown image dans `HumanPromptCard`.
