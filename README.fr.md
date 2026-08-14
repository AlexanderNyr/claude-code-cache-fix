# claude-code-cache-fix

[![npm](https://img.shields.io/npm/v/claude-code-cache-fix?color=blue)](https://www.npmjs.com/package/claude-code-cache-fix) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/cnighswonger/claude-code-cache-fix)](https://github.com/cnighswonger/claude-code-cache-fix/stargazers)

[English](./README.md) | [中文](./README.zh.md) | [한국어](./README.ko.md) | Français | [Português](./docs/guia-pt-br.md)

> **Remarque :** Cette traduction est assistée par machine et peut être en retard par rapport au README anglais. Pour toute information faisant autorité, consultez [README.md](./README.md). Les corrections sont les bienvenues — veuillez ouvrir un PR.
>
> **Note:** This translation is machine-assisted and may lag the English README. For anything authoritative, see [README.md](./README.md). Corrections are very welcome — please open a PR.

Proxy d'optimisation du cache pour [Claude Code](https://github.com/anthropics/claude-code). Corrige les bogues du cache de prompts qui entraînent une consommation excessive de quotas, stabilise le préfixe des requêtes et surveille les régressions silencieuses. Fonctionne avec toutes les versions de CC, y compris le binaire Bun v2.1.113+.

*Ce README documente la branche `main` actuelle ; la disponibilité des versions est notée par fonctionnalité.*

## Ce qu'il fait à votre trafic

Un proxy local se place entre Claude Code et Anthropic. Avant de continuer la lecture, voici exactement ce que cela signifie — le traitement complet se trouve dans [Modèle de sécurité](#modèle-de-sécurité).

- **Se lie à `127.0.0.1`** par défaut.
- **Transmet le trafic de Claude Code à Anthropic. Sur le chemin par défaut, il n'effectue aucun autre appel sortant** — la télémétrie est écrite dans des fichiers locaux sous `~/.claude/`, jamais envoyée nulle part. Deux fonctionnalités optionnelles effectuent leurs propres appels sortants, toutes deux désactivées sauf si vous les activez : le rafraîchissement OAuth (`CACHE_FIX_OAUTH_REFRESH=on`) envoie vers le point de terminaison des jetons d'Anthropic, et l'accélération de téléchargement via proxy forward réémet les téléchargements de versions vers `downloads.claude.ai` / `storage.googleapis.com`.
- **Peut lire et réécrire `POST /v1/messages`.** Cette capacité *est* la réparation du cache — il n'existe aucune version de ceci qui fonctionne sans elle.
- **Elle est idempotente : si rien ne nécessite de correction, la requête passe non modifiée.** Elle normalise la structure de la requête (ordre des blocs, empreinte, TTL) ; elle ne modifie pas votre conversation.
- **Chaque transformation est un fichier** dans `proxy/extensions/`, lisible de manière isolée.
- [Évalué indépendamment comme un outil légitime](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) par @TheAuditorTool (2026-04-14).

Le mode proxy forward (`--remote-control`) termine en plus le TLS pour `api.anthropic.com` en utilisant une CA générée localement, que votre client doit faire confiance. Tout le reste est tunnelé à l'aveugle. Ce mode est optionnel et désactivé par défaut.

## En avez-vous besoin ?

**Installez ou testez-le si :** les sessions reprises ou de longue durée montrent des pics répétés de `cache_creation_input_tokens` ; votre ratio de lecture du cache est faible ou instable ; vous voyez des rétrogradations TTL 5m inattendues, des erreurs `400` de désynchronisation de réflexion, ou des tempêtes de tentatives d'images ; ou si l'une des surfaces non-cache documentées ci-dessous s'applique.

**Vous pouvez l'ignorer si :** vos sessions maintiennent déjà un ratio de lecture du cache stable et élevé ; vous reprenez rarement des sessions longues ; vous n'êtes pas sous pression de quota ; ou vous préférez ne pas placer un proxy local dans le chemin API. **Les quatre sont de bonnes raisons de ne pas installer ceci.**

Si vous n'êtes pas sûr de laquelle s'applique, mesurez-le — vous n'avez pas besoin de ce projet installé pour le découvrir.

## Vérifier si vous avez ce problème

Claude Code enregistre déjà la comptabilité du cache par requête dans ses propres transcriptions de session, vous pouvez donc mesurer la santé de votre cache maintenant, avant d'installer quoi que ce soit.

```bash
# Remplacez <session-uuid>, ou utilisez un glob pour sélectionner votre session la plus récente.
jq -r 'select(.message.usage.cache_read_input_tokens != null) |
  "\(.requestId)\t\(.message.usage.cache_read_input_tokens) \(.message.usage.cache_creation_input_tokens)"' \
  ~/.claude/projects/*/<session-uuid>.jsonl |
  sort -u -k1,1 | cut -f2 |
  awk '{n++; r+=$1; c+=$2}
       END {if (n==0) print "no usage rows found — check the session path";
            else printf "requests=%d cache_read=%d creation=%d read-ratio=%.0f%%\n", n, r, c, 100*r/(r+c)}'
```

`sort -u -k1,1` compte chaque appel API une seule fois — Claude Code écrit plusieurs lignes de transcription par requête, et **pas toujours le même nombre de fois par requête** ([analyse d'ArkNill](https://github.com/ArkNill/claude-code-hidden-problem-analysis)). La somme des lignes brutes pondère chaque appel par son propre nombre de duplicatas. Deux balayages indépendants des transcriptions locales sur une machine (2026-08-02) ont confirmé la tendance : **les courtes sessions sont celles qui posent problème** — plus de la moitié des sessions de moins de 20 requêtes ont décalé d'un point ou plus sans déduplication, pire cas **41 points**, tandis que les longues sessions étaient presque toutes inférieures à un point (3 sur ~37).

Lecture du résultat :

- **Moins de ~20 requêtes : le chiffre est sans signification.** Un démarrage froid n'a rien à lire, donc la création domine et chaque session saine semble cassée. Utilisez une session longue ou reprise.
- **Ratio faible et soutenu sur une longue session, ou `creation` qui explose à chaque `--resume`** — c'est le problème que ce projet existe pour résoudre.
- **Ratio élevé sur une longue session** — vous n'en avez pas besoin. Voir *En avez-vous besoin ?* ci-dessus.

## Avis actuels

> **v4.0.0** — Proxy HTTP local avec un pipeline d'extensions d'impact sur les coûts et d'observabilité. Deux paramètres par défaut de longue date ont été inversés : `thinking-block-sanitize` v1 est activé par défaut (atténue le blocage `400` de désynchronisation de réflexion — [#63147](https://github.com/anthropics/claude-code/issues/63147)) et le rechargement à chaud des extensions en processus est optionnel (`CACHE_FIX_HOT_RELOAD=on`). A/B baseline (v3.0.0 sur v2.1.117) : **95,5% de taux de cache hit via proxy vs 82,3% en direct** sur le premier tour chaud. [Notes de version complètes →](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v4.0.0)

> **Avis Opus 4.7 :** Les données mesurées montrent que 4.7 brûle le quota Q5h à **~2,4x le taux de 4.6** pour des nombres de tokens visibles équivalents ([confirmé indépendamment par @ArkNill](https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/16_OPUS-47-ADVISORY.md)). Deux facteurs : un nouveau tokeniseur (jusqu'à 35% de tokens en plus, [documenté](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)) et le surcoût de la réflexion adaptative (~105%, non documenté dans la réponse d'utilisation). L'impact Q5h se cumule dans le **Q7d** — le plafond hebdomadaire que la plupart des utilisateurs intensifs atteindront en premier. Solution de contournement : `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` réduit la consommation d'environ 3,3x mais peut réduire la qualité sur les tâches complexes. Voir [Discussion #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25) (observation initiale) et [Discussion #42](https://github.com/cnighswonger/claude-code-cache-fix/discussions/42) (données A/B contrôlées + analyse Q7d).

## Démarrage rapide : Proxy (recommandé)

Le proxy fonctionne avec toute version de CC — Node.js ou binaire Bun. Il se place entre Claude Code et l'API Anthropic, appliquant les corrections du cache sous forme d'extensions composable.

```bash
# Installer
npm install -g claude-code-cache-fix

# Démarrer le proxy (s'exécute sur localhost:9801)
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# Lancer Claude Code à travers le proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

C'est tout. Le proxy applique son pipeline d'extensions par défaut automatiquement. Pas de scripts enveloppeur, pas de `NODE_OPTIONS`, pas de préchargement.

### Mode proxy forward (conserve le fonctionnement de Remote Control)

Le démarrage rapide ci-dessus est le **mode proxy inverse** : vous pointez `ANTHROPIC_BASE_URL` vers le proxy. C'est simple, mais sur Claude Code **>= 2.1.196**, un `ANTHROPIC_BASE_URL` non-Anthropic **désactive Remote Control** (`/remote-control`), `/schedule` et les connecteurs MCP de claude.ai (CC traite toute URL de base personnalisée comme une passerelle Bedrock/Vertex). Si vous dépendez de ces fonctionnalités, utilisez le mode proxy forward.

En **mode proxy forward**, le proxy se place devant le *vrai* `api.anthropic.com` en tant que `HTTPS_PROXY`. L'URL de base de Claude Code reste `api.anthropic.com`, donc Remote Control continue de fonctionner, tandis que le proxy voit et transforme toujours `/v1/messages`.

```bash
# Démarrer le proxy en mode forward
CACHE_FIX_FORWARD_PROXY=on node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &
# Il affiche les deux variables d'environnement pour connecter le client, par ex. :
#   export HTTPS_PROXY=http://127.0.0.1:9801
#   export NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem

# Lancer Claude Code à travers le proxy (laissez ANTHROPIC_BASE_URL NON DÉFINI)
HTTPS_PROXY=http://127.0.0.1:9801 \
NODE_EXTRA_CA_CERTS=~/.claude/cache-fix-ca/ca.pem \
  claude
```

Ou laissez le lanceur faire les deux étapes pour vous avec `--remote-control` :

```bash
# Lance le proxy avec CACHE_FIX_FORWARD_PROXY=on et connecte le client
# (HTTPS_PROXY + la CA MITM, ANTHROPIC_BASE_URL laissé non défini) automatiquement.
cache-fix-proxy --remote-control
```

Le drapeau `--remote-control` est l'équivalent en une commande du câblage manuel ci-dessus : il démarre le proxy en mode forward, attend la CA, et lance `claude` pointé sur `HTTPS_PROXY` avec `NODE_EXTRA_CA_CERTS` défini (et ajoute `127.0.0.1,localhost,::1` à `NO_PROXY` pour que les services locaux — par ex. les serveurs MCP HTTP/SSE-transport sur localhost — contournent le proxy au lieu d'être routés vers lui ; tout `NO_PROXY` existant est préservé). Sans le drapeau, le lanceur reste en mode proxy inverse (définit `ANTHROPIC_BASE_URL`), inchangé.

> Si vous câblez le mode proxy forward manuellement (en définissant `HTTPS_PROXY` vous-même au lieu d'utiliser `--remote-control`), définissez aussi `NO_PROXY=127.0.0.1,localhost,::1`, sinon les serveurs MCP HTTP-transport locaux et autres services localhost seront routés vers le proxy cache-fix et échoueront.

Comment ça fonctionne : le proxy gère aussi le HTTP `CONNECT`. Il MITM **uniquement** l'hôte amont (`api.anthropic.com`), terminant le TLS avec une CA générée localement pour pouvoir exécuter le même pipeline d'extensions, et **tunnel à l'aveugle tous les autres CONNECT** (mcp-proxy, télémétrie, npm, ...). Au premier démarrage, il génère une CA sous `$CLAUDE_CONFIG_DIR/cache-fix-ca/` (par défaut `~/.claude/cache-fix-ca/` ; surchargeable via `CACHE_FIX_CA_DIR`) ; le client doit lui faire confiance via `NODE_EXTRA_CA_CERTS`. Un WebSocket/Upgrade vers l'hôte amont (par ex. `/voice`) est relayé tel quel.

L'enchaînement de proxy d'entreprise fonctionne de la même manière : définissez `HTTPS_PROXY`/`HTTP_PROXY` pour la sortie amont **propre** du proxy.

### Exécution en tant que service

**Recommandé (Linux/macOS) — sous-commande `install-service` :**

```bash
cache-fix-proxy install-service
```

Détecte votre plateforme et écrit la configuration appropriée :

- **Linux** → `~/.config/systemd/user/cache-fix-proxy.service` (unité utilisateur systemd)
- **macOS** → `~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist` (agent launchd)

La sortie affiche les commandes de l'étape suivante pour activer et démarrer le service. Sur Linux :

```bash
systemctl --user daemon-reload
systemctl --user enable --now cache-fix-proxy
systemctl --user enable --now cache-fix-proxy-healthcheck.timer   # auto-récupération
sudo loginctl enable-linger $USER   # optionnel : démarrer au démarrage, pas seulement à la connexion
```

**Auto-récupération (Linux) :** `install-service` dépose aussi un compagnon de vérification de santé (`cache-fix-proxy-healthcheck.service` + `.timer`). Le timer se déclenche toutes les 2 minutes ; le service oneshot exécute `curl -fs http://127.0.0.1:<port>/health` et `systemctl --user start cache-fix-proxy.service` si la sonde échoue.

Sur macOS :

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist
launchctl enable gui/$(id -u)/com.cnighswonger.cache-fix-proxy
launchctl kickstart gui/$(id -u)/com.cnighswonger.cache-fix-proxy
```

**Manuel (toute plateforme) :**

```bash
nohup cache-fix-proxy server > /tmp/cache-fix-proxy.log 2>&1 &
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:9801' >> ~/.bashrc
```

### Docker

Une image conteneur multi-arch (amd64, arm64) est publiée sur GitHub Container Registry à chaque tag de version.

```bash
docker run -d --name cache-fix-proxy \
  --restart=always \
  -p 9801:9801 \
  ghcr.io/cnighswonger/claude-code-cache-fix:latest

# Puis dans votre shell :
export ANTHROPIC_BASE_URL=http://127.0.0.1:9801
```

Utilisez `--restart=always` au lieu du compagnon de vérification de santé systemd — Docker gère l'auto-récupération nativement. Sur Linux, vous aurez peut-être besoin de `--add-host=host.docker.internal:host-gateway` pour la résolution de noms.

### Vérification de santé

```bash
curl http://127.0.0.1:9801/health
# {"status":"ok"}
```

### Configuration du proxy

Tous les paramètres du proxy sont contrôlés via des variables d'environnement. Définissez-les avant de démarrer le serveur proxy.

| Variable | Défaut | Description |
|----------|--------|-------------|
| `CACHE_FIX_PROXY_PORT` | `9801` | Port d'écoute |
| `CACHE_FIX_PROXY_BIND` | `127.0.0.1` | Adresse de liaison |
| `CACHE_FIX_PROXY_UPSTREAM` | `https://api.anthropic.com` | URL amont. Changez pour chaîner un autre proxy |
| `CACHE_FIX_FORWARD_PROXY` | non défini | Définir à `on` pour le mode proxy forward |
| `CACHE_FIX_CA_DIR` | `~/.claude/cache-fix-ca` | Répertoire pour la CA du proxy forward |
| `CACHE_FIX_PROXY_TIMEOUT` | `600000` | Délai d'expiration de la requête en millisecondes |
| `CACHE_FIX_EXTENSIONS_DIR` | `proxy/extensions/` | Répertoire des fichiers d'extension `.mjs` |
| `CACHE_FIX_EXTENSIONS_CONFIG` | `proxy/extensions.json` | Fichier de configuration des extensions |
| `CACHE_FIX_DEBUG` | `0` | Activer le logging de débogage |
| `CACHE_FIX_HOT_RELOAD` | non défini | Définir à `on` pour le rechargement à chaud des extensions |

### Environnements d'entreprise (proxys, CA personnalisées)

Le proxy respecte les variables d'environnement suivantes lors de la transmission vers `api.anthropic.com`. Derrière Zscaler / Netskope / Forcepoint / Bluecoat / squid d'entreprise, définissez-les dans l'environnement du proxy.

| Variable | Effet |
|----------|-------|
| `HTTPS_PROXY` / `HTTP_PROXY` | Route les requêtes amont via le proxy HTTP CONNECT de l'entreprise |
| `NO_PROXY` | Liste d'hôtes séparés par des virgules à contourner |
| `CACHE_FIX_PROXY_CA_FILE` | Chemin vers un fichier PEM avec des certificats CA supplémentaires |
| `NODE_EXTRA_CA_CERTS` | Mécanisme Node standard — également respecté |
| `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0` | **Contournement non sécurisé.** Désactive la vérification TLS |

### Vérification de santé

```bash
curl http://127.0.0.1:9801/health
# {"status":"ok"}
```

## Ce que ce proxy défend contre

**Régressions économiques du cache.** Le but original de cache-fix est d'absorber les comportements de gestion du cache dans Claude Code qui coûtent de l'argent réel et des quotas aux utilisateurs — rétrogradations TTL, instabilité des en-têtes, problèmes de verrouillage d'identité, et le reste du catalogue de régressions documenté dans notre historique d'issues. Le proxy se place entre CC et l'API Anthropic, normalise le flux de requêtes et de réponses, et émet suffisamment d'observabilité (via l'intégration de la ligne de statut et les fichiers quota-status) pour que les utilisateurs puissent voir ce que leur session fait réellement.

**Observabilité du canal bootstrap.** Claude Code v2.1.150 a introduit un consommateur de section de prompt qui récupère une chaîne fournie par le serveur depuis `/api/claude_cli/bootstrap` et l'intègre dans le chemin de prompt d'instructions comportementales de l'agent. Nous avons signalé ce comportement à l'équipe de sécurité d'Anthropic en mai 2026 ; Anthropic a clos le rapport comme *Informatif*, traitant TLS comme la limite d'intégrité du transport. cache-fix a publié une gestion explicite pour ce chemin dans v3.7.0 et l'a étendu dans v3.7.1.

Le mode par défaut de l'extension `bootstrap-defense` est `audit` : les réponses bootstrap passent par le proxy vers CC et sont journalisées dans `~/.claude/cache-fix-bootstrap-log.jsonl`. Options `block` (bloque complètement) et `allowlist` (filtrage par clé) disponibles via `CACHE_FIX_BOOTSTRAP_MODE`.

**Protection automatique contre le dépassement de contexte 1M.** CC v2.1.161 et suivants peuvent sélectionner automatiquement le contexte 1M sans demande de l'utilisateur. L'extension `auto-1m-guard` du proxy détecte le jeton `context-1m-2025-08-07` et peut avertir ou le supprimer via `CACHE_FIX_AUTO_1M_GUARD` :

| Mode | Défaut | Comportement |
|------|--------|--------------|
| `off` | non | Extension inactive |
| `warn` | oui | Détecte le jeton, journalise, ne modifie pas la requête |
| `strip` | optionnel | Détecte ET supprime le jeton de l'en-tête `anthropic-beta` |

## Hooks côté client

Certains comportements de Claude Code se situent sous la couche requête — ils se produisent côté client, dans le chemin de dispatch des outils, avant que le proxy ne voie le trafic. cache-fix fournit des scripts de hooks autonomes sous [`hooks/examples/`](hooks/README.md).

| Script | Ce qu'il fait |
|--------|---------------|
| [`worktree-edit-guard.py`](docs/hooks/worktree-edit-guard.md) | Bloque les appels d'outils `Edit`/`Write`/`MultiEdit`/`NotebookEdit` dont le chemin cible sort du worktree git actif |

## Configuration opérationnelle CC recommandée

Le proxy corrige ce qu'il peut corriger au niveau de la requête. Quelques variables d'environnement côté client CC et paramètres `~/.claude/settings.json` résolvent les problèmes adjacents que le proxy ne peut pas atteindre.

### Bloc env suggéré pour `~/.claude/settings.json`

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP": "1",
    "ANTHROPIC_MODEL": "claude-opus-4-7",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001"
  }
}
```

**`CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1`** — le drapeau le plus impactant. CC a un chemin de code hérité qui remap silencieusement votre modèle épinglé vers un autre après certaines mises à jour de version. Le définir à `1` désactive le remappage.

**`ANTHROPIC_MODEL`** — épingle le modèle principal. Garder ceci explicite signifie que le hash du préfixe du cache reste stable.

**`ANTHROPIC_SMALL_FAST_MODEL`** — épigne le modèle « rapide » secondaire que CC utilise pour les appels auxiliaires courts.

### Avertissement `autoCompactWindow=1000000`

Ce réglage ne prend effet que lorsque le modèle actif qualifie pour le contexte 1M. Sans ces prérequis, il se plafonne à 200K quel que soit votre réglage.

## Comportements CC connus qui affectent les coûts du cache

Ce ne sont pas des bogues que cache-fix corrige — ce sont des comportements CC amont dont les utilisateurs doivent être conscients.

### Les commandes slash de diagnostic gonflent l'historique de conversation ([#49335](https://github.com/anthropics/claude-code/issues/49335))

Exécuter `/context`, `/release-notes` (et probablement d'autres commandes d'inspection d'état) ajoute la sortie de diagnostic à l'historique de la conversation au lieu de le rendre uniquement dans le terminal. Les tours suivants rejouent la charge gonflée via le cache de prompt, augmentant le coût en tokens. Mesuré empiriquement à +3 480 `cache_creation_input_tokens` pour un seul appel `/context` sur v2.1.148.

**Solution de contournement :** utilisez ces commandes avec parcimonie dans les longues sessions. `/compact` après un diagnostic pour réinitialiser la fuite.

## Démarrage rapide : Préchargement (CC v2.1.112 et antérieur)

Si vous utilisez une version de CC basée sur Node.js (v2.1.112 ou antérieur), l'intercepteur de préchargement fonctionne sans proxy :

```bash
npm install -g claude-code-cache-fix
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **Note :** Le préchargement ne fonctionne PAS sur CC v2.1.113+ (binaire Bun). Utilisez le proxy ci-dessus.

Consultez [docs/preload-setup.md](docs/preload-setup.md) pour les scripts enveloppeur, les alias shell, les instructions Windows et l'intégration du mode préchargement VS Code.

## Extension VS Code

L'[extension VS Code](https://github.com/cnighswonger/claude-code-cache-fix-vscode) (v0.5.0) supporte les modes proxy et préchargement :

**Mode proxy (recommandé) :**
1. Démarrer le proxy (voir ci-dessus)
2. Dans la palette de commandes VS Code : **Claude Code Cache Fix: Enable Proxy Mode**
3. Redémarrer toute session Claude Code active

**Mode préchargement (CC ≤v2.1.112) :**
1. `npm install -g claude-code-cache-fix`
2. Télécharger le VSIX depuis [GitHub Releases](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest)
3. Installer : `code --install-extension claude-code-cache-fix-0.5.0.vsix`
4. Palette de commandes : **Claude Code Cache Fix: Enable**

## Modèle de sécurité

> **Le proxy et l'intercepteur ont un accès complet en lecture/écriture aux requêtes et réponses API.** C'est inhérent à l'approche — tout intercepteur fetch, proxy ou passerelle a cette position.

**Ce qu'il fait :** Modifie la structure des requêtes sortantes (ordre des blocs, empreinte, TTL, état git) pour corriger les bogues du cache. Lit les en-têtes de réponse et les données d'utilisation SSE pour la surveillance.

**Ce qu'il NE fait pas :** Aucun appel réseau depuis le proxy ou l'intercepteur. Toute la télémétrie est écrite dans des fichiers locaux sous `~/.claude/`. Aucune donnée ne quitte votre machine.

**Chaîne d'approvisionnement :** Mode proxy : petits modules d'extension ciblés dans `proxy/extensions/` (la plupart de quelques centaines de lignes ; le pipeline est composable). Mode préchargement : un seul fichier non minifié (`preload.mjs`). Une dépendance de développement (`zod` uniquement pour la validation de schéma dans les tests). Revoyez avant d'installer.

**Audit indépendant :** [Évalué comme « OUTIL LÉGITIME »](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) par @TheAuditorTool (2026-04-14).

## Le problème

Quand vous utilisez `--resume` ou `/resume` dans Claude Code, le cache de prompt se casse silencieusement. Au lieu de lire les tokens en cache (bon marché), l'API les reconstruit à zéro à chaque tour (coûteux). Une session qui devrait coûter ~0,50$/heure peut brûler 5 à 10$/heure sans indication visible que quelque chose ne va pas.

Trois bogues causent ceci :

1. **Dispersion partielle des blocs** — Les blocs de pièces jointes (liste des compétences, serveurs MCP, outils différés, hooks) sont censés se trouver dans `messages[0]`. À la reprise, certains ou tous se déplacent vers des messages ultérieurs, changeant le préfixe du cache.

2. **Instabilité de l'empreinte** — L'empreinte `cc_version` (par ex. `2.1.92.a3f`) est calculée à partir du contenu de `messages[0]` incluant les blocs méta/pièces jointes. Quand ces blocs se déplacent, l'empreinte change, le prompt système change et le cache se casse.

3. **Ordre non déterministe des outils** — Les définitions d'outils peuvent arriver dans des ordres différents entre les tours, changeant les octets de la requête et invalidant la clé du cache.

De plus, les images lues via l'outil Read persistent en base64 dans l'historique de conversation et sont envoyées à chaque appel API suivant, augmentant silencieusement les coûts en tokens.

## Comment ça fonctionne

**Mode proxy** (v3.0.0+) : Un serveur HTTP sur `localhost:9801` intercepte les requêtes `POST /v1/messages`. Un pipeline de modules d'extension traite chaque requête — normalisant l'ordre des blocs, supprimant les empreintes, stabilisant le tri des outils, gérant les marqueurs TTL, assainissant les blocs de réflexion, enregistrant la télémétrie, et plus. Les extensions vivent comme fichiers `.mjs` configurés dans `proxy/extensions.json` et sont chargées une fois au démarrage du proxy.

**Mode préchargement** (v2.x) : Un module Node.js `--import` qui corrige `globalThis.fetch` avant que Claude Code ne fasse des appels API. Applique les mêmes corrections en ligne.

Les deux modes sont idempotents — si rien ne nécessite de correction, la requête passe non modifiée. Les deux modes ne modifient pas votre conversation ; ils ne normalisent que la structure de la requête avant qu'elle n'atteigne l'API.

## Sortir des corrections

Le paquet sert à trois objectifs avec des cycles de vie différents :

| Objectif | Exemples | Quand désactiver |
|----------|----------|------------------|
| **Corrections de bogues** | Relocalisation des blocs, empreinte, tri des outils, TTL | Quand CC corrige le bogue sous-jacent — vérifiez la ligne de santé |
| **Surveillance** | Suivi des quotas, détection microcompact, drapeaux GrowthBook | Garder indéfiniment — détecte les futures régressions |
| **Optimisations** | Suppression d'images, réécriture d'efficacité | Tant qu'elles aident votre flux de travail |

### État de santé (mode préchargement)

Au premier appel API, l'intercepteur journalise une ligne d'état de santé (nécessite `CACHE_FIX_DEBUG=1`) :

```
cache-fix health: relocate=active(2h ago) fingerprint=dormant(5 clean sessions) tool_sort=active ttl=active identity=waiting
```

- **active(Xh ago)** — correction appliquée récemment
- **dormant(N clean sessions)** — bogue non détecté en N sessions ; CC l'a peut-être corrigé
- **safety-blocked(Nx)** — vérification aller-retour échouée ; correction auto-désactivée
- **waiting** — correction pas encore déclenchée

## Sécurité

### Vérification aller-retour de l'empreinte

Avant de réécrire l'empreinte `cc_version`, l'intercepteur vérifie que son sel codé en dur et ses indices de caractères reproduisent l'empreinte envoyée par Claude Code. Si la vérification échoue (CC a changé son algorithme), la réécriture est automatiquement ignorée. Cela garantit que l'intercepteur ne peut jamais rendre les performances du cache *pires* que CC natif.

### Conception à sécurité intégrée

Chaque correction est conçue pour échouer vers une non-action :
- Si les regex de détection des blocs ne correspondent pas → les blocs ne sont pas relocalisés
- Si le format de l'empreinte change → l'empreinte n'est pas réécrite
- Si le tri des outils ne produit aucun changement → la charge passe non modifiée
- Si la structure cible d'injection TTL change → le TTL n'est pas injecté

L'intercepteur ne peut qu'*aider* ou *ne rien faire*. Il ne peut pas empirer les choses.

## Ligne de statut — avertissements de quota en temps réel

Les deux modes écrivent l'état du quota à chaque appel API. Le mode proxy (v3.5.0+) se divise en `~/.claude/quota-status/account.json` et `~/.claude/quota-status/sessions/<id>.json`. Le script `tools/quota-statusline.sh` inclus affiche une ligne de statut en direct montrant :

- **Q5h** barre de quota `[███░┃░░░░░]` + pourcentage + `(exhaust X, reset Y)`
- **Q7d** même forme avec des durées à l'échelle du jour
- **Niveau TTL** — `TTL:1h` quand sain, **`TTL:5m` en rouge quand le serveur vous a rétrogradé**
- **PEAK** en jaune pendant les heures de pointe en semaine (13:00–19:00 UTC)
- **Taux de cache hit %**
- **Indicateur OVERAGE** quand actif

Exemple de ligne (milieu de fenêtre, état sain) :

```
Q5h [███░┃░░░░░] 30% (exhaust 4h40m, reset 3h00m) | Q7d [█████┃░░░░] 53% (exhaust 3d13h, reset 3d0h) | TTL:1h 98.3%
```

### Installation

```bash
mkdir -p ~/.claude/hooks
cp "$(npm root -g)/claude-code-cache-fix/tools/quota-statusline.sh" ~/.claude/hooks/
chmod +x ~/.claude/hooks/quota-statusline.sh
```

Ajoutez à `~/.claude/settings.json` :

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/hooks/quota-statusline.sh"
  }
}
```

### Recommandé : désactiver l'injection git-status

Claude Code injecte le `git status` en direct dans le prompt système à chaque appel. Toute modification de fichier change le git status, ce qui casse tout le cache de préfixe. Désactiver ceci économise ~1 800 tokens par appel :

```bash
export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

Ou ajoutez `"includeGitInstructions": false` à `~/.claude/settings.json`.

## Suppression d'images (mode préchargement)

Les images lues via l'outil Read persistent en base64 dans l'historique de conversation. Un seul fichier image de 500 Ko coûte ~62 500 tokens par tour sur Opus 4.6, et **~85 000+ sur Opus 4.7** en raison du nouveau tokeniseur.

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

Conserve les images des 3 derniers messages utilisateur, remplace les plus anciennes par un texte de remplacement.

## Résumés de réflexion (mode proxy, optionnel, Opus 4.7+)

Sur Opus 4.7, Anthropic a inversé la valeur par défaut de l'API pour `thinking.display` de `« summarized »` à `« omitted »`. Cette extension injecte le mode configuré à la limite de l'API quand une requête vers un endpoint Opus 4.7 a la réflexion activée mais `display` non défini.

```sh
export CACHE_FIX_THINKING_DISPLAY=summarized   # Restaurer les résumés (défaut)
export CACHE_FIX_THINKING_DISPLAY=omitted       # Suppression forcée
export CACHE_FIX_THINKING_DISPLAY=disabled       # Désactiver l'extension
```

## Assainissement des blocs de réflexion (mode proxy, activé par défaut)

Sur les chemins de rejeu d'historique (reprise / `--continue` / auto-compaction), Claude Code renvoie les réflexions étendues des tours assistant précédents sous forme omise. L'API rejette les réflexions modifiées dans le dernier message assistant avec un `400` permanent. L'extension `thinking-block-sanitize` supprime ces blocs omis avant le transfert.

**Activé par défaut depuis v4.0.0.** `CACHE_FIX_THINKING_SANITIZE=off` pour désactiver explicitement.

## Surveillance et diagnostics

L'intercepteur de préchargement inclut la surveillance de la dégradation microcompact, des faux limiteurs de débit, de l'état des drapeaux GrowthBook, de la télémétrie d'utilisation et des rapports de coûts.

Consultez [docs/monitoring.md](docs/monitoring.md) pour les détails complets, le mode débogage, les variables d'environnement et l'outil d'analyse de quotas.

## Limitations

- **Le proxy nécessite un processus en cours d'exécution** — Le proxy doit être démarré avant Claude Code. S'il n'est pas en cours et que `ANTHROPIC_BASE_URL` pointe vers lui, CC échouera à se connecter.
- **Rétrogradation TTL de dépassement** — Dépasser 100% du quota de 5 heures déclenche une rétrogradation TTL de 1h à 5m côté serveur. Ceci est côté serveur et ne peut pas être corrigé côté client.
- **Le microcompact n'est pas évitable** — Les fonctionnalités de surveillance détectent la dégradation du contexte mais ne peuvent pas la prévenir.
- **La réécriture du prompt système est expérimentale** — Préchargement uniquement, optionnel. À vos propres risques.
- **Couplage de version** — Le sel d'empreinte et les heuristiques de détection des blocs sont dérivés des internals de Claude Code. Un refactoring majeur pourrait nécessiter une mise à jour de ce paquet.

## Recherches connexes

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — Analyse basée sur 38 996 requêtes via proxy : 7 bogues, test causal des drapeaux de fonctionnalités GrowthBook, avis sur le taux de consommation Opus 4.7.
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Envect/X-Ray-Claude-Code-Interceptor)** — Proxy HTTPS de diagnostic avec tableau de bord en temps réel, diffing des sections du prompt système.
- **[@fgrosswig/claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)** — Tableau de bord d'investigation auto-hébergé avec surveillance SSE en direct, agrégation multi-hôtes.

## Utilisé en production

- **[Crunchloop DAP](https://dap.crunchloop.ai)** — Environnement de développement Agent SDK / DAP. Première équipe de production à fusionner l'intercepteur sur le trunk pour un déploiement à l'échelle de l'équipe (2026-04-10).
- **[VM Farms](https://vmfarms.com)** ([@vmfarms](https://github.com/vmfarms)) — Environnement de développement d'agents exécutant des charges de travail multi-runners concurrentes avec `--resume --fork-session`.

## Contributeurs

- **[@VictorSun92](https://github.com/VictorSun92)** — Correctif monkey-patch original pour v2.1.88
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) — Validation de l'environnement de production Agent SDK / DAP, conception et contribution de la fabrique de proxy embarquée
- **[@jmarianski](https://github.com/jmianski)** — Analyse des causes profondes via capture proxy MITM et rétro-ingénierie Ghidra
- **[@cnighswonger](https://github.com/cnighswonger)** — Stabilisation de l'empreinte, correction du tri des outils, suppression d'images, fonctionnalités de surveillance, architecture proxy, mainteneur du paquet
- **[@ArkNill](https://github.com/ArkNill)** — Analyse du mécanisme microcompact, documentation des drapeaux GrowthBook, README coréen (PR #22)
- **[@Renvect](https://github.com/Renvect)** — Découverte de la duplication d'images
- **[@fgrosswig](https://github.com/fgrosswig)** — Méthodologie du tableau de bord d'usage Claude
- **[@TomTheMenace](https://github.com/TomTheMenace)** — Wrapper `.bat` Windows, première validation de plateforme Windows
- **[@deafsquad](https://github.com/deafsquad)** — Correction universelle smoosh_split, architecture proxy proposée et construite pour v3.0.0
- **[@ojura](https://github.com/ojura)** — Analyse des causes profondes des résumés de réflexion Opus 4.7
- **[@schuay](https://github.com/schuay)** — Améliorations de `quota-statusline.sh`
- **[@codeslake](https://github.com/codeslake)** — Mode proxy forward optionnel, respect de `CLAUDE_CONFIG_DIR`
- **[@Gunther-Schulz](https://github.com/Gunther-Schulz)** — Série d'attribution : capture, prefix-diff, normalisation d'insertion, réécriture d'outils différés, garde de sortie
- **[@thepiper18](https://github.com/thepiper18)** — Traduction originale en portugais brésilien

Si vous avez contribué à l'effort communautaire sur ces problèmes et n'êtes pas listé ici, veuillez ouvrir une issue ou un PR — nous voulons créditer tout le monde correctement.

## Soutien

Si cet outil vous a fait économiser de l'argent, envisagez de m'offrir un café :

<a href="https://buymeacoffee.com/vsits" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## Licence

[MIT](LICENSE)
