# ADR-094: Agent type colour coding: a letter tile in one shared palette

**Status:** Accepted (2026-10-06).
**Relates to:** [ADR-073](adr-073_agent-roster-and-task-run-identity.md) §9 (the roster and Task card on a narrow screen; the text badge this replaces), [ADR-065](adr-065_settings-ia-v2-pages-groups-row-vocabulary.md) (the settings page model the colour pickers live in), [ADR-093](adr-093_zoom-trap-no-viewport-units.md) (the zoom the layout tests run under), [ADR-033](adr-033_cross-engine-dispatch.md) (the dispatch card the X tile marks), [ADR-027](adr-027_test-data-attributes.md) (the test ids), mockup `e76a9d48`.

## Context

The agent list and the Task card named an agent's TYPE with a text badge: `general-purpose`, `Explore`,
`migration-reviewer`, and `opencode · deepseek-v4` for a dispatch. On a phone that badge took 60-140px of the
list's second line, which is what the description lost (ADR-073 §9), and on the Task card's footer it was the chip
that pushed the row onto two lines at the owner's chat size. It is also the least scannable thing in the row: eight
agents read as eight words, where the question is "which of these is the reviewer?". And the most common badge,
the engine's default type, says nothing at all.

## Decision

**A letter tile, 16px.** A rounded square with a bold mono letter, in the type's colour on a tint of it. The letter
is the type's INITIAL, uppercased (`Explore` is E, `migration-reviewer` is M); a second letter would not fit, and the
colour and the tooltip tell two types with the same initial apart. `title` and `aria-label` carry the full name.
One renderer, `AgentTypeTile`, serves every surface; the pure logic (letter, palette, resolution) is
`shared/agent-type-colors.ts`, so the surfaces cannot disagree.

**X for a dispatch.** A cross-engine dispatch (ADR-033) is the letter X in one configurable colour (orange until
changed), tooltip `Dispatch → <engine> · <model>`. It is detected by a structured field on the task `ToolView`,
`dispatch?: { engine, model? }`, which every engine's tool map sets through one helper (`dispatchTaskView`).
Nothing parses the old `"engine · model"` label, and a dispatch no longer carries a `subagent`: that field is an
agent TYPE.

**The default type has no tile.** Claude Code and pi `general-purpose`, opencode `general`, Codex role `default`
(`DEFAULT_SUBAGENT_TYPE`). It is the unremarkable case, and a tile on every agent would drown the ones worth telling
apart. A default-type card shows no tile and no type chip; a default-type row's second line is the description alone.

**One shared palette, for every engine.** Eight named colours: sky, violet, green, orange, rose, amber, teal, pink.
Each is a theme token, `--color-agent-<id>` in `main.css`, defined for the dark theme (`@theme`, which Monokai
inherits) and the light theme. Why a palette and not free hex: contrast. A letter has to hold on a tint of its own
colour on the surface it sits on, and a colour picked for one theme is unreadable on the other. The dark values keep
at least 4.5:1 on `bg-secondary` and `bg-tertiary`; the light values are darker so the letter holds 4.5:1 on the
card surface. A test pins that every id is defined in both themes. One palette across engines also means a colour
means the same thing on every harness, and the picker is the same control everywhere.

**Resolution order, for an (engine, type):**

1. the user's override (`AppSettings.agentTypeColors[engine][type]`);
2. the engine's native agent colour, mapped to the NEAREST palette colour;
3. a stable hash of the type name into the palette (FNV-1a over the lowercased name: the same on every machine, nothing
   stored).

**Native-to-palette mapping.** Claude Code's eight names map one-to-one: red to rose, blue to sky, green to green,
yellow to amber, purple to violet, orange to orange, pink to pink, cyan to teal. Eight names, eight distinct palette
colours, every palette colour reachable (a hue match put blue and cyan both on sky and left teal unreachable; a test
pins the bijection). opencode's hex and theme names have no fixed set, so they go to the palette hue nearest around
the circle (so `#22d3ee` and `#60a5fa` both land on sky). A grey, or anything unreadable, has no hue and falls through
to the hash. A trailing YAML comment (`purple  # note`) is ignored.

**Native colour sources.** Claude Code: the `color` frontmatter of `~/.claude/agents/*.md` and
`<cwd>/.claude/agents/*.md`. opencode: the agent's `color` (the lister already reads it). pi and Codex have none, so
they are Auto. The host exposes the known types as a read-only query, `config:list-agent-types (engine, cwd?) ->
{ type, source, nativeColor? }[]` (capability `config`, on both transports like the other `config` reads). Claude:
built-ins plus the two agent directories (a file with no frontmatter `name` is skipped, as cli.js skips it; the walk
is capped at 2000 directory entries per root, and a linked root is read under the same cap while a link inside the
tree is never followed); opencode: the existing lister minus primary-only and hidden agents; pi:
the registry (built-in, user, project); Codex: the built-in roles `default`, `explorer`, `worker`. User Codex roles
(`[agents.<name>]` in `config.toml`) are not listed: reading them means starting an app-server child, which is not
a cheap read for a settings list. The renderer reads the catalog once per (engine, cwd) and shares it between tiles;
there is no polling, and the settings page re-reads on open.

**Codex cards get no tile.** The app-server's `CollabAgentToolCall` item carries the spawn's model and prompt but no
role, and `SubAgentActivity` carries only the agent path (`v2/item.rs`; `agent_role` is a field of the thread, not
of the item). The Codex tool map therefore sets `model` and no `subagent`: a model or a path is never a type. The
settings page still lists the roles. If a later protocol carries the role, mapping it to `subagent` is the whole
change.

**Settings.** Settings › Harnesses › <engine> gets an "Agent colours" group on each of the four engine pages: the
types the engine knows, each with its tile, name, source (Built-in, User agent, Project agent), eight swatches and a
Reset link when overridden; the default type is listed greyed ("Default type, no tile."). It works on the phone: the
swatches wrap to two rows of four there. The cross-engine X colour is one setting, `dispatchTileColor`, on the
Cross-engine dispatch page in its own "Dispatch tile" group, because it marks work handed to ANOTHER harness and
belongs to no engine. Both are ClaudeUI settings (`agentTypeColors`, `dispatchTileColor`) written through the
ordinary `updateSettings` path, so they sync to every client like any setting; both are absent from
`DEFAULT_SETTINGS`, and Reset deletes the key. The groups carry no applies-later badge: a tile re-reads them on the spot.

**Placements.**

- **Agent list** (`AgentRow`, the composer overlay and the side panel alike): the tile replaces the badge, test id
  `AgentRow.typeTile`. Narrow (under 480px, two lines) it LEADS line 2, before the description, so line 1 stays
  name, resumed, metrics. Wide it sits where the badge was.
- **Task card footer** (the header is unchanged), left to right: type, background, model, then resumed and usage when
  wide, and ↗ or "Open in panel" at the right. Narrow it is the tile, the tray icon, the model chip and the ↗ icon;
  wide it is a chip in the type's colour led by the same tile, then the name, then the word "background", the model,
  usage and "Open in panel". Test ids `TaskCard.type` (the chip), `TaskCard.typeTile`, `TaskCard.background`,
  `TaskCard.background.icon`. The narrow row is one line at chat scale 1, 1.1, 1.25 and 1.5 for the common fixtures;
  only a resumed chip at 1.5 wraps, as whole chips with the ↗ last.

## Consequences

- The type is readable at a glance and costs 16px where the badge cost up to 140px; the list's description gets its
  line back.
- Claude's native colours never collide. opencode's hex colours can (two nearby hues share a palette colour); the
  override is the escape hatch. An override matches the type name exactly, else case-insensitively, as pi matches
  agent names.
- A pi card whose type is a comma list (the legacy parallel `subagent` call) is not one type and gets no tile.
- A new engine needs its default type in `DEFAULT_SUBAGENT_TYPE` (a `Record<EngineId, string>`, so it is a compile
  error until filled), and a branch in the catalog.
- The settings page lists the types of the OPEN session's working directory. With no session open, only user-level
  and built-in types appear.
- `AgentRow.badge` is gone; its tests and the layout tests moved to `AgentRow.typeTile`.
