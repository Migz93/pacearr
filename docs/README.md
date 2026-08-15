<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Technical Docs

This folder is Pacearr's long-term technical reference area.

Use these docs for implementation details, subsystem behaviour, and architecture
notes that stay useful after the branch or issue that introduced them is long
gone. Anything that is only true for one branch or issue belongs in that issue,
not in a file here.

## Where Information Lives

| Kind of information | Where it goes |
|---|---|
| Always true, needed on every task | `AGENTS.md` |
| True only while doing a particular kind of work | the matching `docs/*.md` |
| True only for one branch or issue | that issue or PR |

## Shared Docs

These exist in every Migz93 self-hosted app. Each carries a `shared:` marker
comment on its first line saying whether its **content** is kept identical or
only its **structure**, with app-specific content underneath.

| Doc | Read it when | Shared |
|---|---|---|
| [architecture.md](architecture.md) | You need the big-picture mental model before touching the code | structure |
| [deployment.md](deployment.md) | Changing Docker, ports, bind mounts, the entrypoint, or runtime config | structure |
| [workflow.md](workflow.md) | Opening a PR, cutting a release, triaging a Snyk finding, or writing logs and comments | content |
| [maintenance.md](maintenance.md) | Adding background cleanup, pruning, retention, or consistency checks | structure |
| [colour-scheme.md](colour-scheme.md) | Choosing a colour for any UI element, text, or interactive state | structure |

## Pacearr Docs

These are specific to this app and have no equivalent in the sibling projects.

| Doc | Read it when |
|---|---|
| [rolling-monitoring.md](rolling-monitoring.md) | Changing enrollment, baseline application, season expansion, resets, or deletion behaviour |
| [integrations.md](integrations.md) | Changing Plex OAuth/history/session logic, Sonarr API calls, Tautulli import, or matching |
| [jobs-and-history.md](jobs-and-history.md) | Changing scheduled jobs, manual job triggers, event import, or audit/history output |
| [mobile-review.md](mobile-review.md) | Changing layout, adding a page-level container, or adding an `auto-fill`/`minmax()` grid — breakpoints in use and how to verify against a real mobile viewport |

## Maintenance Rule

When a major feature or long-lived internal behaviour changes, update the
relevant doc in this folder in the same branch/PR. If no existing doc fits, add
a new topic doc here and link it from the table above.

If you change a doc marked `shared: content`, make the same change in the sibling
projects. If you change the headings of a doc marked `shared: structure`, change
them in the siblings too — the content underneath is expected to differ.
