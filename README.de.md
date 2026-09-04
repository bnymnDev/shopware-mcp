<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/brand/banner-dark.svg">
    <img src="https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/brand/banner-light.svg" alt="shopware-mcp: der MCP-Server für Shopware 6" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/shopware-mcp"><img src="https://img.shields.io/npm/v/shopware-mcp?color=cb3837&logo=npm&logoColor=white" alt="npm"></a>
  <a href="https://github.com/bnymnDev/shopware-mcp/actions/workflows/ci.yml"><img src="https://github.com/bnymnDev/shopware-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/bnymnDev/shopware-mcp/actions/workflows/e2e.yml"><img src="https://github.com/bnymnDev/shopware-mcp/actions/workflows/e2e.yml/badge.svg" alt="nächtliche E2E-Tests gegen ein echtes Shopware"></a>
  <a href="https://registry.modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP_registry-io.github.bnymnDev%2Fshopware--mcp-0b7bd6" alt="MCP registry"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

<p align="center">
  <a href="#worum-es-geht">Warum</a> ·
  <a href="#so-sieht-es-aus">Demo</a> ·
  <a href="#in-60-sekunden">Installation</a> ·
  <a href="#werkzeuge">Werkzeuge</a> ·
  <a href="#sicherheit">Sicherheit</a> ·
  <a href="README.md">English</a>
</p>

<p align="center"><sub>Dies ist die kompakte deutsche Fassung. Die vollständige Dokumentation, die Parameterreferenz und alle Aufnahmen sind auf Englisch: <a href="README.md">README.md</a>.</sub></p>

---

## Worum es geht

Ein Shopware-6-Shop sind rund zweihundert Entitäten hinter einer Admin-API.
Wer einen Assistenten fragt „Ist im Shop alles in Ordnung?", braucht für eine
ehrliche Antwort sieben Suchen mit Criteria-Filtern, drei State Machines mit
ihren technischen Namen, ein paar Aggregationen und ein OAuth-Token, das der
Assistent niemals wiederholen darf. Hängt man ein Modell direkt an diese API,
bekommt es all das, samt dem Recht, einen Preis per `PATCH` zu ändern, weil ein
Prompt es so wollte.

Das Model Context Protocol hat „gib dem Modell echte Werkzeuge" zu einer
Zeile Konfiguration gemacht. Es sagt nichts darüber, wie ein gutes Werkzeug
für einen *Shop* aussieht: welche der zweihundert Entitäten an einem
Dienstagmorgen zählen, was „hängende Bestellung" heißt, oder dass eine
Bestandskorrektur erst gezeigt und dann gesendet gehört.

**shopware-mcp ist diese Schicht.** Ein kleiner Server, der zum Host MCP
spricht und zum Shop die Admin-API, und Shopware gut genug kennt, um mit
einem Aufruf zu beantworten, was früher einen Nachmittag im Admin gekostet hat:

| | |
|---|---|
| **Kuratierte Werkzeuge** | Produkte, Bestellungen, Kunden, Kategorien, Aktionen, Plugins, Bestand, Verkaufskanäle: sechzehn Werkzeuge mit kompaktem JSON, exakten Trefferzahlen, Beschreibungen für ein Modell und Shopwares eigenen Criteria-Filtern. Keine erfundene Abfragesprache. |
| **Ein Audit** | `shop_audit` prüft acht Dinge in einem Aufruf: bezahlte, nie versandte Bestellungen, unbezahlte Bestellungen, die alt werden, Produkte ohne Bestand oder ohne Bild, abgelaufene Aktionen, Kanäle im Wartungsmodus, Erweiterungen mit Update, und welche EU-Pflichten durch eine installierte Erweiterung abgedeckt scheinen. Priorisiert, mit Beispielen und einem Hinweis je Befund. |
| **Ein Report** | `sales_report` lässt Shopware rechnen: brutto, netto, Durchschnittsbestellung, Umsatz je Währung und Kanal, Bestellungen je Status, eine Zeitreihe nach Tag, Woche oder Monat, die Top-Produkte. Die Zahlen wurden gegen SQL auf derselben Datenbank geprüft. |
| **Eine Hintertür** | `entity_schema` beschreibt jede der über 200 Entitäten, auch die eigenen Entitäten von Plugins, und `entity_search` fragt sie mit denselben Filtern ab. Entitäten mit Zugangsdaten werden verweigert, Geheimnisse im Rest entfernt. |
| **Eine Bremse** | Nur lesend, solange der Server nicht mit `--allow-write` gestartet wird. Und selbst dann ist jeder Schreibzugriff zuerst ein Probelauf, der den genauen Request zeigt. Geheimnisse tauchen nie in Ausgaben, Logs oder Fehlern auf. |

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/brand/architecture-dark.svg">
    <img src="https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/brand/architecture-light.svg" alt="Links ein MCP-Host, in der Mitte shopware-mcp, rechts die Shopware-6-Admin-API. Tool-Aufrufe fließen nach rechts, kompaktes JSON zurück." width="100%">
  </picture>
</p>

Shops sind nicht gleich, also ist es die Werkzeugliste auch nicht: Beim Start
schaut der Server nach, welche Erweiterungen installiert sind, und registriert
zusätzliche Werkzeuge für die, die er kennt. Ein schlichter Shop bekommt den
Kern. Ein Shop mit mehr Plugins bekommt einen größeren Agenten, ohne
Konfiguration.

---

## So sieht es aus

Jede Aufnahme ist echte Ausgabe des Servers gegen einen Shopware-6.7.13-Testshop
mit generierten Demodaten, abgespielt aus den Transkripten in
[`docs/demo/`](docs/demo). Die Aufnahmen sind auf Englisch; Werkzeugaufrufe und
Ergebnisse sind wörtlich, zum Lesen gekürzt.

**Eine Frage, acht Prüfungen.** Drei bezahlte Bestellungen warten auf den
Versand, die Storefront ist im Wartungsmodus, eine Sommeraktion hat den August
überlebt. Die Antwort nennt Bestellnummern und Beträge und bietet den sicheren
nächsten Schritt an.

![shop_audit: eine Frage, priorisierte Befunde mit Beispielen, eine Zusammenfassung](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/demo/audit.svg)

**Zahlen, die der Shop selbst gerechnet hat.** Summen, Kanäle, Status, eine
Monatsreihe und das Top-Produkt für acht Monate, aus einem Aufruf.

![sales_report: Summen, Umsatz je Kanal, Bestellungen je Status, Zeitreihe und Top-Produkte](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/demo/report.svg)

**Kein Werkzeug dafür? Dafür gibt es ein Schema.** Für Hersteller gibt es kein
eigenes Werkzeug. Der Agent liest das Schema der Entität, findet `mediaId` und
filtert darauf. Derselbe Weg führt zu jeder anderen Entität, eigene inklusive.

![entity_schema und entity_search: der Agent findet das Feld mediaId und 27 Hersteller ohne Logo](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/demo/anything.svg)

**Schreibzugriffe zeigen erst ihre Karten.** Mit `--allow-write` kommt eine
Bestandskorrektur als der Request zurück, den sie senden *würde*. Erst ein
ausdrückliches `dryRun: false` verändert den Shop, und das Ergebnis wird aus
Shopware neu gelesen.

![stock_set: der Probelauf zeigt den PATCH, der Agent fragt nach, der echte Schreibzugriff folgt](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/demo/write.svg)

**Ein Shop mit mehr Plugins bekommt einen größeren Agenten.** Die Kernwerkzeuge
sind sofort da. Die Erweiterungssuche endet im Hintergrund, vier Werkzeuge
kommen dazu, der Host wird zum Aktualisieren aufgefordert, und eine
Compliance-Frage hat eine Antwort.

![Plugin-Werkzeuge: tools/list wächst von 16 auf 20, dann beantwortet merqo_health eine Compliance-Frage](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/demo/plugins.svg)

---

## In 60 Sekunden

**1.** Im Shopware-Admin eine Integration anlegen: *Einstellungen → System → Integrationen → Integration hinzufügen*. Zugangsschlüssel-ID und Geheimschlüssel kopieren; der Geheimschlüssel wird nur einmal angezeigt. Für einen Entwicklungsshop *Administrator* ankreuzen, in Produktion eine Leserolle vergeben ([welche Rechte](docs/self-hosting.md#shopware-permissions)).

**2.** Server starten:

```bash
export SHOPWARE_URL=https://shop.example.com
export SHOPWARE_CLIENT_ID=SWIA...
export SHOPWARE_CLIENT_SECRET=...

npx shopware-mcp                       # stdio (Standard)
npx shopware-mcp --http --port 3333    # Streamable HTTP auf http://127.0.0.1:3333/mcp
npx shopware-mcp --allow-write         # zusätzlich die abgesicherten Schreibwerkzeuge
```

**3.** Host verbinden:

<details>
<summary><b>Claude Desktop</b></summary>
<br>

`shopware-mcp.mcpb` aus dem [aktuellen Release](https://github.com/bnymnDev/shopware-mcp/releases/latest) laden und doppelklicken, oder in `claude_desktop_config.json` eintragen:

```json
{
  "mcpServers": {
    "shopware": {
      "command": "npx",
      "args": ["-y", "shopware-mcp"],
      "env": {
        "SHOPWARE_URL": "https://shop.example.com",
        "SHOPWARE_CLIENT_ID": "SWIA...",
        "SHOPWARE_CLIENT_SECRET": "..."
      }
    }
  }
}
```

</details>

<details>
<summary><b>Claude Code</b></summary>
<br>

```bash
claude mcp add shopware \
  -e SHOPWARE_URL=https://shop.example.com \
  -e SHOPWARE_CLIENT_ID=SWIA... \
  -e SHOPWARE_CLIENT_SECRET=... \
  -- npx -y shopware-mcp
```

</details>

<details>
<summary><b>Cursor, VS Code, Zed, Windsurf und andere stdio-Hosts</b></summary>
<br>

Alle nehmen dieselben drei Felder. Cursor liest `.cursor/mcp.json`, VS Code `.vscode/mcp.json` (unter `servers` statt `mcpServers`), Zed seinen `context_servers`-Block. Der Eintrag entspricht dem von Claude Desktop oben. Hosts, die die [offizielle MCP-Registry](https://registry.modelcontextprotocol.io) lesen, finden den Server als `io.github.bnymnDev/shopware-mcp`.

</details>

<details>
<summary><b>Docker und HTTP-Hosts</b></summary>
<br>

```bash
docker run --rm -p 3333:3333 \
  -e SHOPWARE_URL=https://shop.example.com \
  -e SHOPWARE_CLIENT_ID=SWIA... -e SHOPWARE_CLIENT_SECRET=... \
  ghcr.io/bnymndev/shopware-mcp
```

Das Image liefert Streamable HTTP unter `http://127.0.0.1:3333/mcp`. Der Transport hat keine eigene Authentifizierung: auf localhost lassen oder hinter einen Proxy stellen, der authentifiziert ([Hinweise zum Betrieb](docs/self-hosting.md)).

</details>

**4.** Fragen. Die erste nützliche Frage ist meist *„Ist im Shop alles in Ordnung?"*

---

## Fragen, die es beantwortet

| Sie sagen | Der Agent ruft auf |
|---|---|
| „Ist im Shop alles in Ordnung?" | `shop_audit` |
| „Wie lief der August?" | `sales_report { from, to, interval: "week" }` |
| „Welche Produkte haben weniger als 5 auf Lager?" | `products_search` mit einem `range`-Filter, oder der Prompt `low_stock_report` |
| „Fasse Bestellung 10042 für eine Support-Antwort zusammen." | `orders_get`, oder der Prompt `order_summary` |
| „Welche Kunden haben mehr als zehnmal bestellt?" | `customers_search` mit einem `range`-Filter auf `orderCount` |
| „Ist das PayPal-Plugin aktuell?" | `plugins_list` |
| „Welche Hersteller haben kein Logo?" | `entity_schema`, dann `entity_search` auf `product_manufacturer` |
| „Setze den Bestand von SW10084 auf 40." | `stock_set`, erst als Probelauf, dann echt |

Filter sind Shopware-Criteria-Filter (`equals`, `contains`, `range`, `equalsAny`) auf Shopware-Feldpfaden, Assoziationen wie `manufacturer.name` eingeschlossen. Was sich in der Admin-API filtern lässt, lässt sich auch hier filtern. Der [Spickzettel](docs/quickstart.md#filters-cheat-sheet) zeigt die üblichen Fälle.

---

## Werkzeuge

<!-- TOOLS:START -->
| Werkzeug | Zugriff | Zweck |
|---|---|---|
| [`shop_info`](docs/tools.md#shop_info) | read | Shop info |
| [`sales_channels_list`](docs/tools.md#sales_channels_list) | read | List sales channels |
| [`products_search`](docs/tools.md#products_search) | read | Search products |
| [`products_get`](docs/tools.md#products_get) | read | Get product |
| [`orders_search`](docs/tools.md#orders_search) | read | Search orders |
| [`orders_get`](docs/tools.md#orders_get) | read | Get order |
| [`customers_search`](docs/tools.md#customers_search) | read | Search customers |
| [`customers_get`](docs/tools.md#customers_get) | read | Get customer |
| [`categories_list`](docs/tools.md#categories_list) | read | List categories |
| [`promotions_list`](docs/tools.md#promotions_list) | read | List promotions |
| [`plugins_list`](docs/tools.md#plugins_list) | read | List plugins and apps |
| [`stock_get`](docs/tools.md#stock_get) | read | Get stock |
| [`sales_report`](docs/tools.md#sales_report) | read | Sales report |
| [`shop_audit`](docs/tools.md#shop_audit) | read | Shop health audit |
| [`entity_schema`](docs/tools.md#entity_schema) | read | Entity schema |
| [`entity_search`](docs/tools.md#entity_search) | read | Search any entity |
| [`stock_set`](docs/tools.md#stock_set) | write (guarded) | Set stock (guarded) |
| [`product_update`](docs/tools.md#product_update) | write (guarded) | Update product (guarded) |
| [`order_state_transition`](docs/tools.md#order_state_transition) | write (guarded) | Transition order state (guarded) |
| [`promotion_toggle`](docs/tools.md#promotion_toggle) | write (guarded) | Toggle promotion (guarded) |
<!-- TOOLS:END -->

Jeder Parameter jedes Werkzeugs: [docs/tools.md](docs/tools.md). Suchen liefern
`{ total, page, limit, items }` mit exakten Trefferzahlen, `limit` ist auf 50
begrenzt, und Fehler kommen als `{ error: { status, code, detail } }` zurück.

Ressourcen: `shopware://shop`, `shopware://sales-channels`.
Prompts: `order_summary`, `low_stock_report`.

**Plugin-Werkzeuge.** Beim Start fragt der Server im Hintergrund, welche
Erweiterungen installiert und aktiv sind, und registriert zusätzliche Werkzeuge
für die, die er kennt. Heute wird eine Suite unterstützt,
[Merqo](https://github.com/bnymnDev/merqo), mit `merqo_health`,
`merqo_einvoice_inbox`, `merqo_returns_search` und `merqo_abandoned_carts`.
Shops ohne Merqo sehen diese Werkzeuge nie, und die Kernwerkzeuge verhalten
sich in beiden Fällen gleich. `--no-extensions` schaltet den Mechanismus ab.
Unterstützung für die Erweiterungen eines anderen Anbieters ist eine Datei
unter `src/extensions/`; Pull Requests sind willkommen.

---

## Sicherheit

- **Standardmäßig nur lesend.** Ohne `--allow-write` (oder `SHOPWARE_MCP_ALLOW_WRITE=true`) werden die Schreibwerkzeuge gar nicht registriert. Was ein Agent nicht sieht, kann er nicht aufrufen.
- **Jeder Schreibzugriff ist zuerst ein Probelauf.** `stock_set`, `product_update`, `order_state_transition` und `promotion_toggle` stehen auf `dryRun: true` und liefern `{ dryRun: true, wouldSend: { method, url, body } }`. Ein echter Schreibzugriff liefert die neu gelesene Entität.
- **Schmale Schreibzugriffe.** `product_update` ändert Name, Beschreibung, Aktiv-Status und den Preis einer Währung. Sonst nichts.
- **Bereinigte Lesezugriffe.** `entity_search` entfernt Passwörter, Schlüssel, Tokens und Hashes aus jeder Antwort und verweigert Entitäten, die Zugangsdaten oder Systeminterna enthalten: Benutzer, Integrationen, ACL-Rollen, Apps, Systemkonfiguration.
- **Nirgends Geheimnisse.** Zugangsdaten erscheinen nie in Ausgaben, Logs oder Fehlermeldungen. Logs gehen nur nach stderr.
- **Keine Telemetrie.** Der Server spricht mit Ihrem Shop und mit Ihrem Host. Mit niemandem sonst.
- **HTTP-Transport.** Ohne eigene Authentifizierung. Auf localhost lassen (Standard) oder hinter einen authentifizierenden Reverse Proxy stellen.

Etwas gefunden? Siehe [SECURITY.md](SECURITY.md).

---

## Konfiguration

| Variable | Pflicht | Hinweise |
|---|---|---|
| `SHOPWARE_URL` | ja | Basis-URL des Shops, z. B. `https://shop.example.com` |
| `SHOPWARE_CLIENT_ID` | ja | Zugangsschlüssel-ID der Integration |
| `SHOPWARE_CLIENT_SECRET` | ja | Geheimschlüssel der Integration |
| `SHOPWARE_MCP_ALLOW_WRITE` | nein | `true` registriert die Schreibwerkzeuge. Standard: aus |
| `SHOPWARE_MCP_DEFAULT_LIMIT` | nein | Standard-Seitengröße für Suchen (Standard 20, maximal 50) |
| `SHOPWARE_MCP_EXTENSIONS` | nein | `false` schaltet Plugin-Werkzeuge und die Erweiterungssuche beim Start ab |
| `SHOPWARE_LANGUAGE_ID` | nein | Sprach-UUID für übersetzte Felder (`sw-language-id`). Standard: Shopsprache |
| `SHOPWARE_MCP_LOG_LEVEL` | nein | `error` (Standard), `warn`, `info`, `debug`. Logs gehen nur nach stderr |

CLI-Flags überschreiben die Umgebung: `--allow-write`, `--no-extensions`, `--http`, `--port <n>`, `--host <addr>`, `--log-level <level>`.

---

## Open Core

Alles in diesem Repository ist MIT und bleibt es. Es deckt einen Shop, einen Betreiber und interaktive Nutzung ab.

Vom selben Autor stammt [Merqo](https://github.com/bnymnDev/merqo), eine kommerzielle Suite von
Shopware-Erweiterungen für EU-Compliance und den täglichen Betrieb. Dieser Server erkennt sie und
ergänzt passende Werkzeuge, setzt sie aber nie voraus.

Agenturen und Händler, die das im großen Stil betreiben, brauchen meist mehr, und genau das baue und betreibe ich für Kunden:

- **Multi-Shop**: ein MCP-Endpunkt, der auf Dutzende Shops mit eigenen Zugangsdaten und Rechten routet
- **Gehostet mit Audit-Trail**: jeder Werkzeugaufruf protokolliert mit Wer, Was und Wann, rollenbasierter Zugriff, SLA
- **Massenoperationen und Migrationen**: Preis- und Bestandsupdates in Masse, Katalogimporte, sichere Rollbacks
- **Eigene Agenten und Shopware-Plugins**: Workflows für Ihr ERP, PIM oder Ihren Support-Desk

Interesse? Ein Issue mit dem Label `consulting` oder eine Nachricht über [github.com/bnymnDev](https://github.com/bnymnDev). Sie setzen shopware-mcp produktiv ein und wollen, dass es gepflegt bleibt? [Sponsoring](https://github.com/sponsors/bnymnDev) hilft.

---

## Dokumentation

Alle weiteren Dokumente sind auf Englisch:

| Dokument | Inhalt |
|---|---|
| [docs/quickstart.md](docs/quickstart.md) | Integration, erster Start, Host-Konfigurationen, Beispielfragen, Filter-Spickzettel |
| [docs/tools.md](docs/tools.md) | Jedes Werkzeug mit jedem Parameter, aus dem Code generiert |
| [docs/self-hosting.md](docs/self-hosting.md) | Transporte, Docker, Reverse Proxies, Shopware-Rechte, Betrieb |
| [docs/decisions.md](docs/decisions.md) | Designentscheidungen und ihre Begründung |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Einrichtung, Grundregeln, End-to-End-Tests, Releases |
| [SECURITY.md](SECURITY.md) | Was melden und wohin |

## Lizenz

[MIT](LICENSE)

<p align="center"><sub>Wenn shopware-mcp eine Frage beantwortet hat, die der Admin nicht konnte, hilft ein Stern dem nächsten Shop, es zu finden.</sub></p>
