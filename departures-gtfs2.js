/*
 * departures-gtfs2.js
 * Basiert auf departures-trias.js und der Karte von BagelBeef.
 */

class Gtfs2DepartureCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  setConfig(config) {
    this.config = { ...Gtfs2DepartureCard.getStubConfig(), ...config };
    this.renderCard();
  }

  set hass(hass) {
    this._hass = hass;
    this.renderCard();
  }

  connectedCallback() {
    this.renderCard();
    this._interval = setInterval(() => this.renderCard(), 10000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  parseList(value) {
    const values = Array.isArray(value) ? value : String(value ?? "").split(",");
    return values.map(item => String(item).trim()).filter(Boolean);
  }

  parseTime(value) {
    if (typeof value !== "string") return NaN;
    const timestamp = value.trim().replace(" ", "T");
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timestamp)
      ? Date.parse(timestamp)
      : NaN;
  }

  getEntityIds(states, config) {
    const ids = [config.entity, ...this.parseList(config.additional_entities)];
    if (config.local_stop_zone) {
      for (const [id, state] of Object.entries(states)) {
        const attributes = state.attributes;
        if (
          id.startsWith("sensor.") &&
          Object.hasOwn(attributes ?? {}, config.connections_attribute) &&
          (attributes.device_tracker_id === config.local_stop_zone ||
            String(attributes.friendly_name ?? "").endsWith(
              `_local_stop_${config.local_stop_zone}`
            ))
        ) {
          ids.push(id);
        }
      }
    }
    return [...new Set(ids.filter(Boolean))];
  }

  getDepartures(states, entityIds, config) {
    return entityIds.flatMap(id => {
      const state = states[id];
      if (state?.state === "unavailable") return [];

      const items = state?.attributes?.[config.connections_attribute];
      if (!Array.isArray(items)) return [];

      return items.flatMap(item => {
        if (!item || typeof item !== "object") return [];

        const planned = this.parseTime(item.departure_datetime);
        const realtime = this.parseTime(item.departure_realtime_datetime);
        const source = item.realtime_source;
        const rawDelay = item.delay_realtime;
        const delay = (typeof rawDelay === "number" ||
          (typeof rawDelay === "string" && rawDelay.trim()))
          ? Number(rawDelay)
          : NaN;
        const hasRealtime = source === "direct" || source === "estimated" ||
          (source == null && (Number.isFinite(realtime) || Number.isFinite(delay)));
        const delaySeconds = hasRealtime && Number.isFinite(delay) ? delay : 0;
        const time = hasRealtime && Number.isFinite(realtime)
          ? realtime
          : planned + delaySeconds * 1000;
        if (!Number.isFinite(new Date(time).getTime())) return [];

        return [{
          item,
          plannedTime: planned,
          time,
          delaySeconds,
          line: String(item[config.train] ?? item.route_long ?? "?"),
          destination: String(item.headsign ?? "Unbekannt"),
          platform: item[config.platform],
          cancelled: [true, 1, "1"].includes(item[config.isCancelled])
        }];
      });
    });
  }

  filterDepartures(departures, config, now) {
    const targets = this.parseList(config.targets);
    const lines = this.parseList(config.line);
    const stop = config.filterByStop;

    const filtered = departures.filter(departure => {
      if (config.hide_past_departures && departure.time < now - 60000) return false;
      if (targets.length && targets.includes(departure.destination) === Boolean(config.exclude)) {
        return false;
      }
      if (lines.length && lines.includes(departure.line) === Boolean(config.lineExclude)) {
        return false;
      }
      if (!stop) return true;

      const route = departure.item[config.stopAttribute];
      if (!Array.isArray(route)) return departure.item.stop_name === stop;
      const start = config.stationName
        ? route.findIndex(entry => entry?.name === config.stationName)
        : 0;
      return start >= 0 && route.slice(start).some(entry => entry?.name === stop);
    });

    if (config.sort_departures !== false) {
      filtered.sort((a, b) => a.time - b.time);
    }
    if (!config.deduplicate_departures) return filtered;

    const seen = new Set();
    return filtered.filter(departure => {
      const key = JSON.stringify([
        departure.line, departure.destination, departure.time,
        departure.platform ?? "", departure.item.trip_id ?? ""
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  formatClock(time) {
    return new Date(time).toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  getLineColor(config, line, destination) {
    const rules = Array.isArray(config.line_color_rules) ? config.line_color_rules : [];
    let targetColor;
    let defaultColor;
    for (const rule of rules) {
      if (!rule || String(rule.line).trim() !== line) continue;
      const { color } = rule;
      if (!Array.isArray(color) || color.length !== 3 ||
        !color.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
        continue;
      }
      const hex = "#" + color.map(value => value.toString(16).padStart(2, "0")).join("");
      const target = String(rule.destination ?? "").trim();
      if (!target) {
        defaultColor = hex;
      } else if (target === destination) {
        targetColor = hex;
      }
    }

    const lineColors = config.line_colors?.[line];
    const yamlColor = typeof lineColors === "string" ? lineColors : lineColors?.[destination];
    return targetColor ?? defaultColor ?? yamlColor;
  }

  renderRow(departure, config, now) {
    const { plannedTime, delaySeconds, line, destination, platform, cancelled } = departure;
    const currentMinute = Math.floor(now / 60000);
    const delayMinutes = Math.sign(delaySeconds) * Math.ceil(Math.abs(delaySeconds) / 60);
    let timeText = "–";
    if (Number.isFinite(plannedTime)) {
      const remainingMinutes = (plannedTime - now) / 60000;
      const plannedMinute = Math.floor(plannedTime / 60000);
      const countdownLimit = Math.min(config.limit, 30);
      if (!delayMinutes && plannedMinute === currentMinute) {
        timeText = "Jetzt";
      } else if (config.relativeTime && plannedMinute > currentMinute &&
        remainingMinutes <= countdownLimit) {
        timeText = `In ${Math.max(1, Math.round(remainingMinutes))} Min.`;
      } else if (config.convertTimeHHMM === false) {
        timeText = new Date(plannedTime).toISOString();
      } else {
        timeText = this.formatClock(plannedTime);
      }
    }

    const delayText = delayMinutes
      ? `${delayMinutes > 0 ? "+" : "-"}${Math.abs(delayMinutes)} Min.`
      : "";
    const predictionTime = delayMinutes || !Number.isFinite(plannedTime)
      ? departure.time
      : plannedTime;
    const predictionText = Math.floor(predictionTime / 60000) === currentMinute
      ? "Jetzt"
      : this.formatClock(predictionTime);
    const lineColor = this.getLineColor(config, line, destination);
    const lineStyle = typeof lineColor === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(lineColor)
      ? ` style="color: ${lineColor}"`
      : "";

    return `
      <tr class="departure-row${cancelled ? " cancelled" : ""}${delayMinutes ? " has-delay" : ""}">
        <td class="train"><strong${lineStyle}>${this.escapeHtml(line)}</strong></td>
        <td class="destination">
          <span class="destination-text">${this.escapeHtml(destination)}</span>
        </td>
        ${config.show_platform
          ? `<td class="platform">${this.escapeHtml(platform || "N/A")}</td>`
          : ""}
        <td class="departure">${this.escapeHtml(timeText)}</td>
        <td class="delay">${delayText ? `<span>${this.escapeHtml(delayText)}</span>` : ""}</td>
        <td class="prediction" title="Prognose">${this.escapeHtml(predictionText)}</td>
      </tr>
    `;
  }

  renderCard() {
    const config = this.config;
    const states = this._hass?.states;
    if (!config || !states) return;

    const now = Date.now();
    const ids = this.getEntityIds(states, config);
    const departures = this.getDepartures(states, ids, config);
    const filtered = this.filterDepartures(departures, config, now);
    const rows = filtered.slice(0, config.displayed_connections)
      .map(departure => this.renderRow(departure, config, now)).join("");
    const message = ids.some(id => states[id])
      ? "Keine passenden Abfahrten verfügbar."
      : "Keine konfigurierten GTFS2-Sensoren gefunden.";
    this.shadowRoot.innerHTML = `
      <ha-card>
        <style>
          :host {
            display: block;
            min-width: 0;
          }

          ha-card {
            display: block;
            container-type: inline-size;
          }

          .card-content {
            box-sizing: border-box;
            max-width: 100%;
            padding: 16px;
            overflow-x: auto;
          }

          .card-content.text-xs {
            font-size: var(--ha-font-size-xs);
          }

          .card-content.text-s {
            font-size: var(--ha-font-size-s);
          }

          .card-content.text-m {
            font-size: var(--ha-font-size-m);
          }

          .card-content.text-l {
            font-size: var(--ha-font-size-l);
          }

          .card-content.text-xl {
            font-size: var(--ha-font-size-xl);
          }

          h1 {
            font-size: 16px;
            font-weight: 500;
            line-height: 1.3;
            margin: 0 0 8px 0;
          }

          .filtered-stop {
            color: var(--secondary-text-color);
            margin-top: 0;
          }

          .table {
            width: 100%;
            border-collapse: collapse;
          }

          .departure-row td {
            border-bottom:
              var(--ha-card-border-width, 1px)
              solid
              var(
                --ha-card-border-color,
                var(--divider-color, #e0e0e0)
              );
            line-height: 1.2;
            padding: 4px;
          }

          .departure-row:last-child td {
            border-bottom: 0 none;
          }

          .departure-row td:last-child {
            padding-right: 16px;
          }

          .departure-row .departure,
          .departure-row .prediction {
            color: var(--success-color);
          }

          .departure-row .delay,
          .departure-row.has-delay .prediction {
            color: var(--error-color);
          }

          .cancelled {
            text-decoration: line-through;
            opacity: 0.6;
          }

          .departure-row td.train {
            text-align: left;
            white-space: nowrap;
            padding-left: 16px;
          }

          .departure-row td.destination {
            text-align: left;
            max-width: 150px;
          }

          .destination-text {
            display: block;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .departure-row td.platform {
            text-align: left;
            white-space: nowrap;
          }

          .departure-row td.departure,
          .departure-row td.prediction {
            text-align: right;
            white-space: nowrap;
          }

          .departure-row td.delay {
            text-align: left;
            padding-left: 4px;
            min-width: 20px;
            white-space: nowrap;
          }

          @container (max-width: 520px) {
            .card-content {
              padding-inline: 8px;
            }

            .departure-row td {
              padding-inline: 3px;
            }

            .departure-row td.train {
              padding-left: 4px;
            }

            .departure-row td:last-child {
              padding-right: 4px;
            }

            .departure-row td.delay {
              min-width: 0;
              padding-left: 3px;
            }

            .departure-row td.destination {
              width: 100%;
              max-width: 0;
            }

            .destination-text {
              display: -webkit-box;
              -webkit-box-orient: vertical;
              -webkit-line-clamp: 2;
              white-space: normal;
              overflow-wrap: anywhere;
            }
          }

          @container (max-width: 300px) {
            .table {
              font-size: min(1em, clamp(11px, 4.8cqw, 14px));
            }
          }

        </style>
        <div class="card-content text-${this.escapeHtml(config.fontSize)}">
          <h1>${this.escapeHtml(config.title)}</h1>
          ${config.filterByStop
            ? `<p class="filtered-stop">Haltestelle: ${this.escapeHtml(config.filterByStop)}</p>`
            : ""}
          ${rows
            ? `<table class="table"><tbody>${rows}</tbody></table>`
            : `<p>${this.escapeHtml(message)}</p>`}
        </div>
      </ha-card>
    `;
  }

  static getStubConfig() {
    return {
      title: "Abfahrten",
      entity: "",
      additional_entities: [],
      local_stop_zone: "",
      connections_attribute: "next_departures_lines",
      displayed_connections: 5,
      fontSize: "s",
      convertTimeHHMM: true,
      relativeTime: false,
      limit: 30,
      targets: "",
      exclude: false,
      line: "",
      lineExclude: false,
      line_colors: {},
      sort_departures: true,
      deduplicate_departures: false,
      hide_past_departures: false,
      train: "route",
      platform: "platform",
      show_platform: false,
      isCancelled: "isCancelled",
      stopAttribute: "route",
      filterByStop: "",
      stationName: ""
    };
  }

  static getConfigForm() {
    const labels = {
      title: "Kartentitel",
      entity: "Hauptsensor",
      additional_entities: "Weitere Sensoren",
      local_stop_zone: "Haltestellenzone",
      connections_attribute: "Attribut für Abfahrten",
      train: "Attribut für die Liniennummer",
      isCancelled: "Attribut für Ausfälle",
      platform: "Attribut für den Steig",
      show_platform: "Steig anzeigen",
      displayed_connections: "Anzahl der Abfahrten",
      fontSize: "Schriftgröße",
      line_color_rules: "Farben nach Linie und Ziel",
      convertTimeHHMM: "Fahrplanzeit als Uhrzeit anzeigen",
      relativeTime: "Minuten bis zur geplanten Abfahrt anzeigen",
      limit: "Countdown bis zu dieser Minutenzahl anzeigen",
      targets: "Fahrtziele (durch Kommas getrennt)",
      exclude: "Angegebene Fahrtziele ausblenden",
      line: "Linien (durch Kommas getrennt)",
      lineExclude: "Angegebene Linien ausblenden",
      sort_departures: "Abfahrten chronologisch sortieren",
      deduplicate_departures: "Doppelte Abfahrten entfernen",
      hide_past_departures: "Vergangene Abfahrten ausblenden",
      stopAttribute: "Attribut für den Haltestellenverlauf",
      filterByStop: "Nach Haltestelle filtern",
      stationName: "Name der Einstiegshaltestelle"
    };

    return {
      computeLabel: field => labels[field.name] ?? field.name,
      schema: [
        {
          name: "title",
          required: true,
          selector: { text: {} }
        },
        {
          name: "entity",
          selector: { entity: {} }
        },
        {
          name: "additional_entities",
          selector: {
            entity: { multiple: true }
          }
        },
        {
          name: "local_stop_zone",
          selector: { entity: { filter: { domain: "zone" } } }
        },
        {
          name: "connections_attribute",
          required: true,
          selector: { text: {} }
        },

        {
          type: "constant",
          name: "Sensorattribute"
        },
        {
          name: "",
          type: "grid",
          multiple: false,
          default: {},
          schema: [
            {
              name: "train",
              selector: { text: {} }
            },
            {
              name: "isCancelled",
              selector: { text: {} }
            },
            {
              name: "platform",
              selector: { text: {} }
            },
            {
              name: "show_platform",
              selector: { boolean: {} }
            }
          ]
        },

        {
          type: "constant",
          name: "Anzeige"
        },
        {
          name: "",
          type: "grid",
          multiple: false,
          default: {},
          schema: [
            {
              name: "displayed_connections",
              required: true,
              selector: {
                number: {
                  min: 1,
                  max: 20,
                  mode: "box"
                }
              }
            },
            {
              name: "fontSize",
              required: true,
              selector: {
                select: {
                  mode: "dropdown",
                  options: [
                    {
                      label: "Sehr klein",
                      value: "xs"
                    },
                    {
                      label: "Klein",
                      value: "s"
                    },
                    {
                      label: "Mittel",
                      value: "m"
                    },
                    {
                      label: "Groß",
                      value: "l"
                    },
                    {
                      label: "Sehr groß",
                      value: "xl"
                    }
                  ]
                }
              }
            }
          ]
        },

        {
          name: "line_color_rules",
          selector: {
            object: {
              multiple: true,
              fields: {
                line: { label: "Liniennummer", required: true, selector: { text: {} } },
                destination: {
                  label: "Fahrtziel",
                  description: "Zielnamen aus der Karte übernehmen. Leer lassen, um alle Ziele der Linie einzufärben.",
                  selector: { text: {} }
                },
                color: {
                  label: "Farbe",
                  required: true,
                  default: [66, 165, 245],
                  selector: { color_rgb: {} }
                }
              }
            }
          }
        },

        {
          type: "constant",
          name: "Zeitanzeige"
        },
        {
          name: "",
          type: "grid",
          multiple: false,
          default: {},
          schema: [
            {
              name: "convertTimeHHMM",
              selector: { boolean: {} }
            },
            {
              name: "relativeTime",
              selector: { boolean: {} }
            },
            {
              name: "limit",
              selector: {
                number: {
                  min: 1,
                  max: 30,
                  mode: "box"
                }
              }
            }
          ]
        },

        {
          type: "constant",
          name: "Filter"
        },
        {
          name: "",
          type: "grid",
          multiple: false,
          default: {},
          schema: [
            {
              name: "targets",
              selector: { text: {} }
            },
            {
              name: "exclude",
              selector: { boolean: {} }
            },
            {
              name: "line",
              selector: { text: {} }
            },
            {
              name: "lineExclude",
              selector: { boolean: {} }
            },
            {
              name: "sort_departures",
              selector: { boolean: {} }
            },
            {
              name: "deduplicate_departures",
              selector: { boolean: {} }
            },
            {
              name: "hide_past_departures",
              selector: { boolean: {} }
            },
            {
              name: "stopAttribute",
              selector: { text: {} }
            },
            {
              name: "filterByStop",
              selector: { text: {} }
            },
            {
              name: "stationName",
              selector: { text: {} }
            }
          ]
        }
      ]
    };
  }
}

if (!customElements.get("departures-gtfs2")) {
  customElements.define("departures-gtfs2", Gtfs2DepartureCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === "departures-gtfs2")) {
  window.customCards.push({
    type: "departures-gtfs2",
    name: "GTFS2 Abfahrten",
    preview: true,
    description: "Abfahrten mehrerer GTFS2-Haltestellen mit Echtzeitdaten anzeigen"
  });
}
