export const WEB_ANALYTICS_DASHBOARD_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <meta name="theme-color" content="#f4effa">
    <title>Site analytics · Mira</title>
    <style>
      :root { color-scheme: light; font-family: "Avenir Next", "Nunito", ui-rounded, system-ui, sans-serif; color: #352f47; background: #f4effa; --ink: #352f47; --muted: #756e81; --line: #eee8f2; --lilac: #765fc3; }
      * { box-sizing: border-box; }
      body { min-width: 320px; min-height: 100vh; margin: 0; padding: 28px 18px 48px; background: radial-gradient(ellipse at 12% 12%, #f7e9f1 0, transparent 34%), radial-gradient(ellipse at 88% 86%, #e8e5fb 0, transparent 33%), #f4effa; }
      main { width: min(100%, 1100px); margin: 0 auto; }
      .panel { padding: clamp(22px, 5vw, 42px); border: 1px solid #fff; border-radius: 28px; background: #fffdfd; box-shadow: 0 24px 80px #5948781b; }
      .eyebrow { margin: 0 0 8px; color: var(--lilac); font-size: 10px; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; }
      h1 { margin: 0; color: var(--ink); font-size: clamp(28px, 5vw, 38px); letter-spacing: -.05em; }
      h2 { margin: 0; font-size: 17px; letter-spacing: -.02em; }
      .lede { max-width: 720px; margin: 11px 0 0; color: var(--muted); font-size: 14px; line-height: 1.7; }
      .gate { width: min(100%, 520px); margin: 12vh auto 0; }
      .gate-form { display: grid; gap: 12px; margin-top: 24px; }
      label { color: #514961; font-size: 12px; font-weight: 750; }
      input, select { width: 100%; min-height: 46px; padding: 10px 13px; border: 1px solid #e8e1ed; border-radius: 13px; outline: none; color: var(--ink); background: white; font: inherit; }
      input:focus, select:focus { border-color: #b8a8dd; box-shadow: 0 0 0 4px #a890d91c; }
      button { min-height: 43px; border: 0; border-radius: 13px; padding: 0 16px; color: white; background: linear-gradient(145deg, #9a81da, #7259bd); font: inherit; font-weight: 750; cursor: pointer; }
      button:hover { background: linear-gradient(145deg, #8d74d0, #634cac); }
      button:focus-visible { outline: 3px solid #b4a3e7; outline-offset: 3px; }
      button:disabled { cursor: wait; opacity: .65; }
      .subtle-button { border: 1px solid #e7deef; color: #695a82; background: #fff; }
      .subtle-button:hover { background: #f6f2fb; }
      .message { min-height: 20px; margin: 12px 0 0; color: #a34e65; font-size: 13px; line-height: 1.5; }
      .dashboard[hidden], .gate[hidden] { display: none; }
      .toolbar { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 14px; margin-top: 26px; }
      .range-control { width: min(220px, 100%); display: grid; gap: 7px; }
      .toolbar-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .privacy-note { margin: 18px 0 0; padding: 11px 14px; border: 1px solid #eee7f4; border-radius: 13px; color: #71687d; background: #faf7fc; font-size: 12px; line-height: 1.6; }
      .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 20px; }
      .metric { min-width: 0; padding: 17px; border: 1px solid var(--line); border-radius: 17px; background: white; }
      .metric-label { margin: 0; color: var(--muted); font-size: 11px; font-weight: 700; }
      .metric-value { display: block; margin-top: 8px; color: var(--ink); font-size: clamp(21px, 3vw, 29px); font-weight: 800; letter-spacing: -.04em; overflow-wrap: anywhere; }
      .metric-help { margin: 6px 0 0; color: #8a8294; font-size: 10px; line-height: 1.45; }
      .sections { display: grid; gap: 15px; margin-top: 18px; }
      .section { min-width: 0; padding: 20px; border: 1px solid var(--line); border-radius: 19px; background: white; }
      .section-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; }
      .section-help { margin: 5px 0 0; color: #8a8294; font-size: 11px; }
      .chart { display: grid; gap: 7px; max-height: 390px; overflow: auto; margin-top: 15px; padding-right: 4px; }
      .bar-row { display: grid; grid-template-columns: 94px minmax(30px, 1fr) 56px; align-items: center; gap: 9px; min-height: 20px; color: #71687d; font-size: 11px; }
      .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bar-track { height: 10px; overflow: hidden; border-radius: 999px; background: #f1edf6; }
      .bar-fill { height: 100%; min-width: 0; border-radius: inherit; background: linear-gradient(90deg, #b49ae8, #8c78d1 68%, #df9fbd); }
      .bar-count { color: #514961; font-variant-numeric: tabular-nums; text-align: right; }
      .table-wrap { width: 100%; overflow-x: auto; margin-top: 13px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; white-space: nowrap; }
      th, td { padding: 9px 10px; border-bottom: 1px solid #f0ebf3; text-align: left; }
      th { color: #766d82; font-size: 10px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
      td { color: #514961; font-variant-numeric: tabular-nums; }
      td:first-child { font-variant-numeric: normal; }
      .tables-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px; }
      .empty { padding: 17px 0; color: #8a8294; font-size: 12px; }
      .footnote { margin: 18px 0 0; color: #8a8294; font-size: 11px; line-height: 1.65; }
      @media (max-width: 760px) { .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .tables-grid { grid-template-columns: 1fr; } }
      @media (max-width: 430px) { body { padding: 12px 10px 28px; } .panel { border-radius: 21px; } .metric { padding: 13px; } .section { padding: 15px; } .bar-row { grid-template-columns: 78px minmax(28px, 1fr) 42px; gap: 7px; } }
    </style>
  </head>
  <body>
    <main>
      <section id="gate" class="panel gate" aria-labelledby="page-title">
        <p class="eyebrow">Mira · private dashboard</p>
        <h1 id="page-title">Site analytics</h1>
        <p class="lede">Review first-party visits and feature usage. The dashboard needs the server-only analytics token; it is never placed in the URL.</p>
        <form id="token-form" class="gate-form">
          <label for="admin-token">Analytics admin token</label>
          <input id="admin-token" type="password" autocomplete="off" required>
          <button id="unlock" type="submit">Open dashboard</button>
        </form>
        <p id="gate-message" class="message" role="status" aria-live="polite"></p>
      </section>

      <section id="dashboard" class="panel dashboard" aria-labelledby="dashboard-title" hidden>
        <p class="eyebrow">Mira · private dashboard</p>
        <h1 id="dashboard-title">Site analytics</h1>
        <p class="lede">Visits and anonymous feature counts from people who opted in to analytics. All periods use UTC.</p>
        <div class="toolbar">
          <label class="range-control" for="range">Report period
            <select id="range">
              <option value="7">Last 7 days</option>
              <option value="30" selected>Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </label>
          <div class="toolbar-actions">
            <button id="refresh" class="subtle-button" type="button">Refresh</button>
            <button id="lock" class="subtle-button" type="button">Lock dashboard</button>
          </div>
        </div>
        <p id="report-message" class="message" role="status" aria-live="polite"></p>
        <p class="privacy-note">Privacy by design: analytics stores no chat text, prompts, attachment contents, IP addresses, full referrers, or raw browser IDs. “Unique visitors” means pseudonymous browsers that accepted analytics—not verified people.</p>
        <div class="metrics" aria-label="Summary metrics">
          <article class="metric"><p class="metric-label">Page views</p><strong id="metric-views" class="metric-value">—</strong><p class="metric-help">Accepted visits to the site</p></article>
          <article class="metric"><p class="metric-label">Unique browsers</p><strong id="metric-visitors" class="metric-value">—</strong><p class="metric-help">Approximate, consented browser IDs</p></article>
          <article class="metric"><p class="metric-label">Sessions</p><strong id="metric-sessions" class="metric-value">—</strong><p class="metric-help">A new session after 30 minutes idle</p></article>
          <article class="metric"><p class="metric-label">Returning browsers</p><strong id="metric-returning" class="metric-value">—</strong><p class="metric-help">Seen before this report period</p></article>
        </div>
        <div class="sections">
          <section class="section" aria-labelledby="daily-title">
            <div class="section-heading"><h2 id="daily-title">Daily visits</h2><span id="daily-range" class="section-help"></span></div>
            <p class="section-help">Page views by UTC day</p>
            <div id="daily-chart" class="chart" role="list" aria-label="Daily page view chart"></div>
          </section>
          <div class="tables-grid">
            <section class="section" aria-labelledby="weekly-title">
              <div class="section-heading"><h2 id="weekly-title">Weekly visits</h2></div>
              <div id="weekly-table" class="table-wrap"></div>
            </section>
            <section class="section" aria-labelledby="monthly-title">
              <div class="section-heading"><h2 id="monthly-title">Monthly visits</h2></div>
              <div id="monthly-table" class="table-wrap"></div>
            </section>
          </div>
          <div class="tables-grid">
            <section class="section" aria-labelledby="pages-title">
              <div class="section-heading"><h2 id="pages-title">Top pages</h2></div>
              <div id="pages-table" class="table-wrap"></div>
            </section>
            <section class="section" aria-labelledby="events-title">
              <div class="section-heading"><h2 id="events-title">Feature usage</h2></div>
              <div id="events-table" class="table-wrap"></div>
            </section>
          </div>
        </div>
        <p id="updated-at" class="footnote"></p>
        <p class="footnote">Analytics data is kept locally on the server for up to 90 days (maximum 100,000 events). On free hosts with temporary storage it may disappear after a restart or redeploy. This dashboard is a lightweight, self-hosted tool—not a substitute for a full analytics platform.</p>
      </section>
    </main>
    <script>
      const gate = document.querySelector("#gate");
      const dashboard = document.querySelector("#dashboard");
      const tokenForm = document.querySelector("#token-form");
      const tokenInput = document.querySelector("#admin-token");
      const gateMessage = document.querySelector("#gate-message");
      const reportMessage = document.querySelector("#report-message");
      const rangeSelect = document.querySelector("#range");
      const unlockButton = document.querySelector("#unlock");
      let token = "";

      function showGate(message) {
        dashboard.hidden = true;
        gate.hidden = false;
        gateMessage.textContent = message || "";
      }

      function showDashboard() {
        gate.hidden = true;
        dashboard.hidden = false;
      }

      function makeCell(row, value, heading) {
        const cell = document.createElement(heading ? "th" : "td");
        if (heading) cell.scope = "col";
        cell.textContent = String(value);
        row.append(cell);
      }

      function renderTable(container, headers, rows, emptyMessage) {
        container.replaceChildren();
        if (!rows.length) {
          const empty = document.createElement("p");
          empty.className = "empty";
          empty.textContent = emptyMessage;
          container.append(empty);
          return;
        }
        const table = document.createElement("table");
        const head = document.createElement("thead");
        const headerRow = document.createElement("tr");
        for (const header of headers) makeCell(headerRow, header, true);
        head.append(headerRow);
        const body = document.createElement("tbody");
        for (const values of rows) {
          const row = document.createElement("tr");
          for (const value of values) makeCell(row, value, false);
          body.append(row);
        }
        table.append(head, body);
        container.append(table);
      }

      function renderChart(rows) {
        const chart = document.querySelector("#daily-chart");
        chart.replaceChildren();
        const max = Math.max(1, ...rows.map((row) => row.pageViews));
        for (const row of rows) {
          const line = document.createElement("div");
          line.className = "bar-row";
          line.setAttribute("role", "listitem");
          const label = document.createElement("span");
          label.className = "bar-label";
          label.textContent = row.period;
          const track = document.createElement("div");
          track.className = "bar-track";
          track.setAttribute("role", "img");
          track.setAttribute("aria-label", row.pageViews + " page views");
          const fill = document.createElement("div");
          fill.className = "bar-fill";
          fill.style.width = row.pageViews ? Math.max(2, (row.pageViews / max) * 100) + "%" : "0%";
          track.append(fill);
          const count = document.createElement("span");
          count.className = "bar-count";
          count.textContent = String(row.pageViews);
          line.append(label, track, count);
          chart.append(line);
        }
      }

      function renderReport(report) {
        document.querySelector("#metric-views").textContent = report.totals.pageViews.toLocaleString();
        document.querySelector("#metric-visitors").textContent = report.totals.uniqueVisitors.toLocaleString();
        document.querySelector("#metric-sessions").textContent = report.totals.sessions.toLocaleString();
        document.querySelector("#metric-returning").textContent = report.totals.returningVisitors.toLocaleString();
        document.querySelector("#daily-range").textContent = "Last " + report.days + " days";
        renderChart(report.daily);
        renderTable(
          document.querySelector("#weekly-table"),
          ["Week of", "Views", "Browsers", "Sessions"],
          report.weekly.slice(-12).reverse().map((row) => [row.period, row.pageViews, row.uniqueVisitors, row.sessions]),
          "No visits in this period yet.",
        );
        renderTable(
          document.querySelector("#monthly-table"),
          ["Month", "Views", "Browsers", "Sessions"],
          report.monthly.slice().reverse().map((row) => [row.period, row.pageViews, row.uniqueVisitors, row.sessions]),
          "No visits in this period yet.",
        );
        renderTable(
          document.querySelector("#pages-table"),
          ["Page", "Views", "Browsers"],
          report.topPages.map((row) => [row.path, row.pageViews, row.uniqueVisitors]),
          "No page views yet.",
        );
        const eventNames = {
          page_view: "Page views",
          chat_message_sent: "Chat messages sent",
          image_generation_requested: "Image requests",
          attachment_uploaded: "Attachments uploaded",
          voice_input_started: "Voice input started",
        };
        renderTable(
          document.querySelector("#events-table"),
          ["Event", "Count"],
          report.eventBreakdown.map((row) => [eventNames[row.type] || row.type, row.count]),
          "No feature events yet.",
        );
        document.querySelector("#updated-at").textContent =
          "Report refreshed " + new Date(report.generatedAt).toLocaleString() + " (UTC). " +
          report.totals.interactions.toLocaleString() + " feature interactions recorded in this period.";
      }

      async function loadReport() {
        if (!token) return;
        reportMessage.textContent = "Loading analytics…";
        try {
          const response = await fetch("/api/analytics/report?days=" + encodeURIComponent(rangeSelect.value), {
            headers: { Authorization: "Bearer " + token },
            cache: "no-store",
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) {
            if (response.status === 401 || response.status === 503) {
              token = "";
              showGate(result.error || "Analytics access is unavailable.");
              return;
            }
            throw new Error(result.error || "Could not load analytics.");
          }
          renderReport(result);
          reportMessage.textContent = "";
          showDashboard();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not load analytics.";
          if (gate.hidden) reportMessage.textContent = message;
          else gateMessage.textContent = message;
        }
      }

      tokenForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (unlockButton.disabled) return;
        token = tokenInput.value.trim();
        tokenInput.value = "";
        if (!token) return;
        unlockButton.disabled = true;
        await loadReport();
        unlockButton.disabled = false;
      });

      document.querySelector("#refresh").addEventListener("click", () => void loadReport());
      rangeSelect.addEventListener("change", () => void loadReport());
      document.querySelector("#lock").addEventListener("click", () => {
        token = "";
        showGate("");
        tokenInput.focus();
      });
    </script>
  </body>
</html>`;
