import * as vscode from 'vscode';
import { TrackerDatabase } from '../../db/database';
import {
  WebviewMessage,
  ExtensionMessage,
  OverviewData,
  SessionListData,
  SessionDetailData,
  ProviderId,
} from '../../core/types';
import { dateStringToEpoch } from '../../util/dateUtils';
import {
  computeBillingStatus, getBillingPeriodBounds, computeClaudeBilling,
  computeCostUSD, computeListCostUSD, getPricing,
} from '../../stats/billingCalculator';
import { getConfig } from '../../config';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private activeProvider: ProviderId;

  private constructor(
    panel: vscode.WebviewPanel,
    private db: TrackerDatabase,
    private extensionUri: vscode.Uri,
    initialProvider: ProviderId
  ) {
    this.panel = panel;
    this.activeProvider = initialProvider;
    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static createOrShow(db: TrackerDatabase, extensionUri: vscode.Uri, initialProvider: ProviderId = 'copilot'): void {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'copilotUsageDashboard',
      'AI Usage Dashboard',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );
    DashboardPanel.currentPanel = new DashboardPanel(panel, db, extensionUri, initialProvider);
  }

  /** Called by the extension when the provider toggle changes — re-query + re-render. */
  public setActiveProvider(provider: ProviderId): void {
    this.activeProvider = provider;
    this.refresh();
  }

  public refresh(): void {
    this.postMessage({ type: 'overview', data: this.getOverviewData() });
  }

  private handleMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'requestOverview':
        this.postMessage({ type: 'overview', data: this.getOverviewData() });
        break;
      case 'setProvider': {
        // Route through the command so the trees + globalState update in lockstep.
        vscode.commands.executeCommand('copilotUsageTracker.setProvider', msg.provider);
        break;
      }
      case 'requestSessions': {
        const dateFrom = msg.dateFrom ? dateStringToEpoch(msg.dateFrom) : undefined;
        const dateTo = msg.dateTo ? dateStringToEpoch(msg.dateTo) + 86400000 : undefined;
        const sessions = this.db.getSessionsWithStats(dateFrom, dateTo, this.activeProvider);
        this.postMessage({ type: 'sessions', data: { sessions, groupBy: msg.groupBy } });
        break;
      }
      case 'requestSessionDetail': {
        const detail = this.db.getSessionDetail(msg.sessionId);
        if (detail) {
          const analytics = this.db.getSessionAnalytics(msg.sessionId);
          const toolCalls = this.db.getSessionToolCalls(msg.sessionId);
          // Pricing is computed here, from the single canonical table, so the webview
          // never carries its own (drift-prone) copy of model prices.
          const requests = detail.requests.map(r => {
            const tier = getPricing(r.model, r.inputTokens);
            return {
              ...r,
              costUSD: computeCostUSD(r.model, r),          // billed amount when reported
              listCostUSD: computeListCostUSD(r.model, r),  // list price, for ratios
              rateInput: tier.input,
              rateOutput: tier.output,
            };
          });
          this.postMessage({ type: 'sessionDetail', data: { ...detail, requests, analytics, toolCalls } });
        } else {
          this.postMessage({ type: 'error', message: `Session ${msg.sessionId} not found` });
        }
        break;
      }
      case 'requestBilling': {
        const config = getConfig();
        const wf = this.db.getWorkflowSummary(msg.periodStart, msg.periodEnd, this.activeProvider);
        const workflow = {
          toolCalls: wf.totalToolCalls,
          subagents: wf.totalSubagents,
          turns: wf.totalTurns,
          errors: wf.totalErrors,
          turnsPerMsg: wf.avgTurnsPerMessage,
          toolsPerTurn: wf.avgToolsPerTurn,
        };
        const modelStats = this.db.getModelStats(msg.periodStart, msg.periodEnd, this.activeProvider);
        if (this.activeProvider === 'claude') {
          // Claude: USD/token view — never run computeBillingStatus (§15 #5).
          const cb = computeClaudeBilling(
            this.db, { start: msg.periodStart, end: msg.periodEnd },
            msg.periodLabel, config.claudeCostBasis, msg.periodLabel !== 'All Time'
          );
          this.postMessage({ type: 'claudeBilling', data: { ...cb, modelStats, workflow } });
        } else {
          const billing = computeBillingStatus(
            this.db, config.plan, Date.now(),
            { start: msg.periodStart, end: msg.periodEnd }
          );
          this.postMessage({
            type: 'billingStatus',
            data: { ...this.mapBilling(billing, msg.periodLabel), modelStats, workflow },
          });
        }
        break;
      }
      case 'refresh':
        this.postMessage({ type: 'overview', data: this.getOverviewData() });
        break;
    }
  }

  private mapBilling(billing: ReturnType<typeof computeBillingStatus>, periodLabel: string): NonNullable<OverviewData['billing']> {
    return {
      periodLabel,
      isHistoricalPeriod: billing.isHistoricalPeriod,
      plan: billing.plan,
      daysRemaining: billing.daysRemaining,
      notes: billing.notes,
      activity: billing.activity,
      new: {
        used: billing.new.aiCreditsUsed,
        quota: billing.new.aiCreditsQuota,
        quotaIsPromotional: billing.new.quotaIsPromotional,
        pct: billing.new.percentUsed,
        costUSD: billing.new.estimatedCostUSD,
        cachedTokensCaptured: billing.new.cachedTokensCaptured,
        cachedTokensEstimated: billing.new.cachedTokensEstimated,
        breakdown: billing.new.costBreakdown,
      },
    };
  }

  private getOverviewData(): OverviewData {
    const config = getConfig();
    const provider = this.activeProvider;
    const now = new Date();
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
    const { start: periodStart, end: periodEnd } = getBillingPeriodBounds();
    const wf = this.db.getWorkflowSummary(periodStart, periodEnd, provider);
    const base = {
      provider,
      aggregate: this.db.getAggregateStats(undefined, undefined, provider),
      dailyStats: this.db.getDailyStats(undefined, undefined, provider),
      modelStats: this.db.getModelStats(periodStart, periodEnd, provider),
      topSessions: this.db.getTopSessions(10, provider),
      availableMonths: this.db.getAvailableMonths(provider),
      workflow: {
        toolCalls: wf.totalToolCalls,
        subagents: wf.totalSubagents,
        turns: wf.totalTurns,
        errors: wf.totalErrors,
        turnsPerMsg: wf.avgTurnsPerMessage,
        toolsPerTurn: wf.avgToolsPerTurn,
      },
    };
    if (provider === 'claude') {
      return {
        ...base,
        claudeBilling: computeClaudeBilling(this.db, { start: periodStart, end: periodEnd }, periodLabel, config.claudeCostBasis, false),
      };
    }
    return { ...base, billing: this.mapBilling(computeBillingStatus(this.db, config.plan), periodLabel) };
  }

  private postMessage(msg: ExtensionMessage): void {
    this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Usage Dashboard</title>
<style nonce="${nonce}">
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-widget-border);
    --card-bg: var(--vscode-editorWidget-background);
    --accent: var(--vscode-textLink-foreground);
    --muted: var(--vscode-descriptionForeground);
    --badge-bg: var(--vscode-badge-background);
    --badge-fg: var(--vscode-badge-foreground);
    --success: #3fb950;
    --warning: #d29922;
    --danger: #f85149;
    --claude: #d97757;   /* Anthropic/Claude orange */
    --copilot: var(--vscode-charts-blue, #3794ff);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); padding: 20px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.3em; margin-bottom: 16px; font-weight: 600; }
  h2 { font-size: 1em; margin: 20px 0 10px; color: var(--accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; font-size: 0.8em; }

  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
  .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: var(--muted); font-size: 0.9em; }
  .tab:hover { color: var(--fg); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* Billing section */
  .billing-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .billing-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .billing-card h3 { font-size: 0.85em; color: var(--muted); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
  .billing-card .headline { font-size: 1.8em; font-weight: 700; margin-bottom: 4px; }
  .billing-card .sub { font-size: 0.8em; color: var(--muted); margin-bottom: 12px; }
  .progress-bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin-bottom: 8px; }
  .progress-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .progress-fill.low { background: var(--success); }
  .progress-fill.mid { background: var(--warning); }
  .progress-fill.high { background: var(--danger); }
  .billing-breakdown { font-size: 0.8em; color: var(--muted); }
  .billing-breakdown .row { display: flex; justify-content: space-between; padding: 3px 0; }
  .billing-comparison { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .billing-comparison .verdict { font-size: 0.95em; font-weight: 600; padding: 8px 12px; border-radius: 4px; display: inline-block; }
  .billing-comparison .verdict.more { background: rgba(248,81,73,0.1); color: var(--danger); }
  .billing-comparison .verdict.less { background: rgba(63,185,80,0.1); color: var(--success); }
  .billing-comparison .verdict.same { background: rgba(210,153,34,0.1); color: var(--warning); }
  .billing-comparison .note { font-size: 0.8em; color: var(--muted); margin-top: 8px; }

  /* Metric cards */
  .metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .metric { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
  .metric .label { font-size: 0.7em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; }
  .metric .value { font-size: 1.2em; font-weight: 600; margin-top: 2px; }

  /* Charts */
  .chart-container { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  canvas { width: 100% !important; max-height: 250px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { text-align: left; padding: 8px; border-bottom: 2px solid var(--border); color: var(--muted); cursor: pointer; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.3px; }
  th:hover { color: var(--fg); }
  td { padding: 8px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: var(--card-bg); }
  tr.clickable { cursor: pointer; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75em; background: var(--badge-bg); color: var(--badge-fg); }
  .badge-repo { background: rgba(56,132,244,0.15); color: var(--accent); font-weight: 600; }
  .badge-otel { background: rgba(63,185,80,0.15); color: var(--success); font-size: 0.7em; font-weight: 700; }
  .badge-hybrid { background: rgba(210,153,34,0.15); color: var(--warning); font-size: 0.7em; font-weight: 700; }
  .badge-jsonl { background: rgba(139,148,158,0.12); color: var(--muted); font-size: 0.7em; font-weight: 700; }

  .loading { text-align: center; padding: 40px; color: var(--muted); }
  .filters { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .filters input, .filters select { background: var(--card-bg); color: var(--fg); border: 1px solid var(--border); padding: 4px 8px; border-radius: 4px; font-size: 0.85em; }
  .filters button { background: var(--accent); color: var(--badge-fg); border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85em; }

  .detail-back { cursor: pointer; color: var(--accent); margin-bottom: 12px; display: inline-block; font-size: 0.9em; }
  .request-list { margin-top: 12px; }
  .request-item { background: var(--card-bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px 12px; margin-bottom: 6px; }
  .request-item .meta { font-size: 0.8em; color: var(--muted); }

  /* Session analytics */
  .signals-box { background: rgba(210,153,34,0.08); border: 1px solid var(--warning); border-radius: 6px; padding: 10px 14px; margin: 12px 0; }
  .signal { font-size: 0.85em; padding: 3px 0; color: var(--warning); }
  .analytics-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin: 12px 0 20px; }
  .analytics-col { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 14px; }
  .analytics-col h3 { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.4px; color: var(--accent); margin-bottom: 10px; }
  .stat-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 0.85em; border-bottom: 1px solid var(--border); }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { color: var(--muted); }
  .stat-value { font-weight: 600; }

  /* Insight bars */
  .insight-bar { height: 8px; border-radius: 4px; overflow: hidden; display: flex; background: var(--border); margin: 8px 0 2px; }
  .insight-bar-fill { height: 100%; }
  .insight-bar-fill.prod { background: var(--accent); }
  .insight-bar-fill.expl { background: var(--muted); }
  .insight-bar-fill.meta { background: var(--warning); }
  .insight-bar-fill.ctx-low { background: #4caf50; }
  .insight-bar-fill.ctx-mid { background: #ff9800; }
  .insight-bar-fill.ctx-high { background: #f44336; }
  .insight-bar-labels { display: flex; justify-content: space-between; font-size: 0.7em; color: var(--muted); }
  .eff-good { color: #4caf50; font-weight: 600; }
  .eff-normal { color: var(--muted); }
  .eff-bad { color: var(--danger); font-weight: 600; }

  /* Timeline */
  .timeline { margin-top: 12px; border-left: 2px solid var(--border); padding-left: 16px; }
  .tl-msg { padding: 8px 12px; margin: 10px 0; background: rgba(63,185,80,0.06); border: 1px solid rgba(63,185,80,0.2); border-radius: 4px; position: relative; }
  .tl-msg::before { content: ''; position: absolute; left: -21px; top: 12px; width: 8px; height: 8px; background: var(--success); border-radius: 50%; }
  .tl-llm { padding: 8px 12px; margin: 4px 0; background: var(--card-bg); border: 1px solid var(--border); border-radius: 4px; position: relative; }
  .tl-llm::before { content: ''; position: absolute; left: -21px; top: 12px; width: 8px; height: 8px; background: var(--accent); border-radius: 50%; }
  .tl-llm-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .tl-toolgroup { padding: 4px 12px; margin: 2px 0; font-size: 0.82em; position: relative; color: var(--muted); border-left: 2px solid var(--border); margin-left: 4px; padding-left: 10px; }
  .tl-toolgroup::before { content: ''; position: absolute; left: -21px; top: 8px; width: 4px; height: 4px; background: var(--muted); border-radius: 50%; }
  .tl-tools-inline { font-size: 0.95em; }
  .tl-error { border-color: rgba(248,81,73,0.3) !important; background: rgba(248,81,73,0.05) !important; }
  .tl-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.7em; font-weight: 700; letter-spacing: 0.3px; vertical-align: middle; }
  .tl-badge-msg { background: rgba(63,185,80,0.15); color: var(--success); }
  .tl-badge-llm { background: rgba(56,132,244,0.15); color: var(--accent); }
  .tl-badge-sub { background: rgba(210,153,34,0.15); color: var(--warning); }
  .tl-badge-tool { background: rgba(139,148,158,0.15); color: var(--muted); }
  .tl-model { font-weight: 600; font-size: 0.9em; }
  .tl-action { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.68em; font-weight: 600; letter-spacing: 0.2px; }
  .act-route { background: rgba(139,148,158,0.12); color: var(--muted); }
  .act-plan { background: rgba(56,132,244,0.1); color: var(--accent); }
  .act-analyze { background: rgba(163,113,247,0.1); color: #a371f7; }
  .act-reason { background: rgba(210,153,34,0.1); color: var(--warning); }
  .act-edit { background: rgba(63,185,80,0.1); color: var(--success); }
  .act-respond { background: rgba(56,132,244,0.12); color: var(--accent); }
  .act-generate { background: rgba(63,185,80,0.15); color: var(--success); font-weight: 700; }
  .tl-err-tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.7em; font-weight: 700; background: rgba(248,81,73,0.15); color: var(--danger); }
  .tl-detail { display: flex; justify-content: space-between; font-size: 0.82em; margin-top: 4px; color: var(--fg); }
  .tl-cost { font-weight: 600; color: var(--warning); }
  .tl-delta { color: var(--warning); font-size: 0.9em; }
  .tl-reasoning { color: #a371f7; font-size: 0.9em; font-weight: 600; }
  .tl-cached { color: var(--success); font-size: 0.9em; }
  .tl-gap { color: var(--warning); font-weight: 600; }
  .tl-meta { font-size: 0.78em; color: var(--muted); margin-top: 2px; }
  .tl-running { font-size: 0.75em; color: var(--muted); margin-top: 3px; padding-top: 3px; border-top: 1px dashed var(--border); }
  .tl-text { font-size: 0.85em; }
  .tl-msg .tl-meta { display: block; margin-top: 4px; }
  .tl-efficiency { font-size: 0.76em; margin-top: 3px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .tl-eff-tag { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; font-weight: 600; }
  .tl-eff-productive { background: rgba(63,185,80,0.1); color: var(--success); }
  .tl-eff-exploration { background: rgba(139,148,158,0.1); color: var(--muted); }
  .tl-eff-routing { background: rgba(210,153,34,0.08); color: var(--warning); }
  .tl-eff-item { color: var(--muted); }
  .tl-eff-good { color: var(--success); }
  .tl-eff-warn { color: var(--warning); }
  .tl-eff-bad { color: var(--danger); }

  /* Expandable timeline items (click to see full detail) */
  details.tl-msg > summary,
  details.tl-toolgroup > summary,
  details.tl-raw > summary { cursor: pointer; list-style: none; outline: none; user-select: none; }
  details.tl-msg > summary::-webkit-details-marker,
  details.tl-toolgroup > summary::-webkit-details-marker,
  details.tl-raw > summary::-webkit-details-marker { display: none; }
  .chev::after { content: ' ▸'; color: var(--muted); font-size: 0.9em; }
  details[open] > summary .chev::after { content: ' ▾'; }
  .tl-expand { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); }
  .tl-kv { display: flex; justify-content: space-between; gap: 16px; padding: 2px 0; font-size: 0.92em; }
  .tl-kv .k { color: var(--muted); white-space: nowrap; }
  .tl-kv .v { text-align: right; word-break: break-all; }
  .tl-full { white-space: pre-wrap; word-break: break-word; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px; margin: 6px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; max-height: 340px; overflow: auto; }
  .tl-toollist { margin-top: 6px; }
  .tl-toolrow { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; padding: 5px 0 1px; align-items: baseline; }
  .tl-toolrow .tname { font-weight: 600; }
  .tl-toolrow .tstatus.err { color: var(--danger); font-weight: 600; }
  .tl-toolrow .tdur { color: var(--muted); }
  .tl-toolsub { font-size: 0.78em; color: var(--muted); padding-bottom: 5px; border-bottom: 1px solid var(--border); }
  .tl-toollist > .tl-toolsub:last-child { border-bottom: none; }
  .tl-expand-hint { color: var(--accent); font-size: 0.78em; margin-left: 6px; }
  details.tl-raw { margin-top: 6px; }
  details.tl-raw > summary { color: var(--accent); font-size: 0.78em; }

  /* Legend */
  .legend { margin-top: 24px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.85em; }
  .legend summary { padding: 10px 14px; cursor: pointer; color: var(--accent); font-weight: 600; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.3px; }
  .legend summary:hover { background: var(--card-bg); }
  .legend dl { padding: 0 14px 14px; margin: 0; }
  .legend dt { font-weight: 600; margin-top: 10px; color: var(--fg); }
  .legend dd { margin: 3px 0 0 0; color: var(--muted); line-height: 1.5; }

  /* Provider toggle */
  .provider-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .provider-pill { background: var(--card-bg); color: var(--muted); border: none; padding: 4px 12px; cursor: pointer; font-size: 0.85em; font-family: inherit; }
  .provider-pill:hover { color: var(--fg); }
  .provider-pill.active { color: #fff; font-weight: 600; }
  .provider-pill.active[data-provider="copilot"] { background: var(--copilot); }
  .provider-pill.active[data-provider="claude"]  { background: var(--claude); }
  /* Colored provider dot next to the dashboard title. */
  .title-dot { margin-right: 8px; font-size: 0.7em; vertical-align: middle; }
  .title-dot.copilot { color: var(--copilot); }
  .title-dot.claude  { color: var(--claude); }
</style>
</head>
<body>
<h1 id="dashboard-title"><span id="title-dot" class="title-dot copilot">●</span><span id="title-text">AI Usage Dashboard</span></h1>

<div class="tabs">
  <div class="tab active" data-tab="overview">Overview</div>
  <div class="tab" data-tab="sessions">Sessions</div>
</div>

<div id="overview" class="tab-content active">
  <div class="loading" id="overview-loading">Loading...</div>
  <div id="overview-content" style="display:none;">
    <div id="billing-period-row" style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap;">
      <div class="provider-toggle" id="provider-toggle">
        <button type="button" class="provider-pill" data-provider="copilot">GitHub Copilot</button>
        <button type="button" class="provider-pill" data-provider="claude">Claude</button>
      </div>
      <select id="billing-period-select" style="background:var(--card-bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:4px 10px;font-size:0.85em;cursor:pointer;min-width:160px;">
        <option value="">Loading\u2026</option>
      </select>
    </div>
    <div id="billing-section"></div>
    <h2>Workflow</h2>
    <div class="metrics" id="workflow-metrics"></div>
    <h2>Usage</h2>
    <div class="metrics" id="overview-cards"></div>
    <h2>Daily Token Usage (last 30 days)</h2>
    <div class="chart-container"><canvas id="dailyChart"></canvas></div>
    <h2>Model Distribution</h2>
    <div class="chart-container"><canvas id="modelChart"></canvas></div>
    <h2>Top Sessions</h2>
    <table id="topSessionsTable"><thead><tr>
      <th>Date</th><th>Tokens</th><th>Cost</th><th>Model</th><th>Chat reqs</th>
    </tr></thead><tbody></tbody></table>
  </div>
</div>

<div id="sessions" class="tab-content">
  <div class="filters">
    <label>From: <input type="date" id="dateFrom"></label>
    <label>To: <input type="date" id="dateTo"></label>
    <button id="filterBtn">Filter</button>
  </div>
  <table id="sessionsTable"><thead><tr>
    <th data-sort="startTime">Date</th>
    <th data-sort="totalTokens">Tokens</th>
    <th data-sort="_costJun">Cost</th>
    <th data-sort="_costPerMsg">$ / Msg</th>
    <th data-sort="dominantModel">Model</th>
    <th data-sort="repository">Repo</th>
    <th data-sort="userMessageCount">Chat reqs</th>
    <th data-sort="durationMs">Duration</th>
  </tr></thead><tbody></tbody></table>
</div>

<div id="sessionDetail" class="tab-content">
  <span class="detail-back" id="detailBack">&larr; Back to sessions</span>
  <div id="detailContent"></div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let overviewData = null;
let sessionsData = [];
let activeProvider = 'copilot';
let sortCol = 'startTime';
let sortDir = -1;

// Pricing is computed by the extension from the canonical table in
// src/stats/billingCalculator.ts and attached to the data it sends: detail requests
// carry 'costUSD' (billed amount when the log reports it, else list price),
// 'listCostUSD', 'rateInput', 'rateOutput'.
// The webview deliberately has no price table of its own.
function sessionBilling(s) {
  // Cost is always computed by the extension (stored session cost).
  const costUSD = (typeof s.costUSD === 'number') ? s.costUSD
                : (typeof s.cost_usd === 'number') ? s.cost_usd
                : 0;
  const credits = Math.round(costUSD * 100 * 10) / 10;
  return { credits, costUSD };
}

// Provider toggle pills
document.querySelectorAll('.provider-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const p = pill.dataset.provider;
    if (p === activeProvider) { return; }
    // Reset caches so the Sessions tab refetches for the new provider.
    sessionsData = [];
    overviewData = null;
    vscode.postMessage({ type: 'setProvider', provider: p });
  });
});

function applyProviderChrome() {
  document.body.dataset.provider = activeProvider;
  const dot = document.getElementById('title-dot');
  const txt = document.getElementById('title-text');
  if (dot) { dot.className = 'title-dot ' + activeProvider; }
  if (txt) { txt.textContent = activeProvider === 'claude' ? 'Claude Code Usage' : 'GitHub Copilot Usage'; }
  document.querySelectorAll('.provider-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.provider === activeProvider);
  });
}

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'sessions' && sessionsData.length === 0) {
      vscode.postMessage({ type: 'requestSessions', groupBy: 'date' });
    }
  });
});

vscode.postMessage({ type: 'requestOverview' });

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'overview': renderOverview(msg.data); break;
    case 'sessions': renderSessions(msg.data); break;
    case 'sessionDetail': renderDetail(msg.data); break;
    case 'billingStatus':
      renderBilling(msg.data);
      if (msg.data.modelStats) { renderModelChart(msg.data.modelStats); }
      if (msg.data.workflow)   { renderWorkflow(msg.data.workflow); }
      break;
    case 'claudeBilling':
      renderClaudeBilling(msg.data);
      if (msg.data.modelStats) { renderModelChart(msg.data.modelStats); }
      if (msg.data.workflow)   { renderWorkflow(msg.data.workflow); }
      break;
  }
});

function renderOverview(data) {
  overviewData = data;
  activeProvider = data.provider || 'copilot';
  applyProviderChrome();
  document.getElementById('overview-loading').style.display = 'none';
  document.getElementById('overview-content').style.display = 'block';

  populateBillingPeriodSelect(data.availableMonths || []);
  if (activeProvider === 'claude') { renderClaudeBilling(data.claudeBilling); }
  else { renderBilling(data.billing); }
  renderWorkflow(data.workflow);
  renderMetrics(data.aggregate);
  renderDailyChart(data.dailyStats);
  renderModelChart(data.modelStats);
  renderTopSessions(data.topSessions);
}

function renderClaudeBilling(b) {
  const el = document.getElementById('billing-section');
  if (!b) { el.innerHTML = ''; return; }
  const t = b.tokenTotals || { input: 0, output: 0, cachedInput: 0, cacheWrite: 0 };
  const costLabel = b.costBasis === 'subscription' ? 'API-equivalent cost' : 'Cost (Anthropic list price)';
  let html = '<h2>Billing — Claude' + (b.periodLabel ? ' | ' + esc(b.periodLabel) : '') + '</h2>';
  html += '<div class="billing-grid">';
  html += '<div class="billing-card">';
  html += '<h3>' + esc(costLabel) + '</h3>';
  html += '<div class="headline">$' + (b.costUSD || 0).toFixed(2) + '</div>';
  html += '<div class="sub">' + esc(b.periodLabel || '') + '</div>';
  html += '<div class="billing-breakdown">';
  html += '<div class="row" style="font-weight:600"><span>Model</span><span>Cost</span></div>';
  for (const m of (b.perModel || []).slice(0, 5)) {
    html += '<div class="row"><span>' + esc(m.model) + '</span><span>$' + m.costUSD.toFixed(2) + ' (' + fmt(m.inputTokens) + ' in / ' + fmt(m.outputTokens) + ' out)</span></div>';
  }
  html += '</div></div>';
  // "Fresh" (billable) input = inclusive input minus the cached prefix (cache read)
  // and the cache-write bucket. The headline shows fresh + output so it is comparable
  // to Claude Code's own usage panel (which excludes re-read cached tokens); the full
  // cache-inclusive input is shown as a breakdown row. Cost still uses inclusive input.
  const freshIn = Math.max(0, t.input - t.cachedInput - t.cacheWrite);
  html += '<div class="billing-card">';
  html += '<h3>Tokens</h3>';
  html += '<div class="headline">' + fmt(freshIn + t.output) + '</div>';
  html += '<div class="sub">' + fmt(freshIn) + ' fresh in · ' + fmt(t.output) + ' out</div>';
  html += '<div class="billing-breakdown">';
  html += '<div class="row"><span>Cache read (0.1× input)</span><span>' + fmt(t.cachedInput) + '</span></div>';
  html += '<div class="row"><span>Cache write</span><span>' + fmt(t.cacheWrite) + '</span></div>';
  html += '<div class="row"><span>Total input incl. cache</span><span>' + fmt(t.input) + '</span></div>';
  html += '</div></div>';
  html += '</div>';
  html += '<div class="billing-comparison">';
  for (const n of (b.notes || [])) { html += '<div class="note">[i] ' + esc(n) + '</div>'; }
  html += '</div>';
  el.innerHTML = html;
}

// Keyed period options map populated by populateBillingPeriodSelect.
let _periodOptions = {};

function populateBillingPeriodSelect(months) {
  const sel = document.getElementById('billing-period-select');
  if (!sel) { return; }
  _periodOptions = {};
  sel.innerHTML = '';
  months.forEach((m, i) => {
    const key = 'month_' + i;
    _periodOptions[key] = m;
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = m.label;
    if (i === 0) { opt.selected = true; }
    sel.appendChild(opt);
  });
  // Add "All Time" option.
  _periodOptions['alltime'] = { label: 'All Time', start: 0, end: 253402300800000 };
  const optAll = document.createElement('option');
  optAll.value = 'alltime';
  optAll.textContent = 'All Time (total)';
  sel.appendChild(optAll);

  sel.onchange = function() {
    const p = _periodOptions[this.value];
    if (p) {
      vscode.postMessage({ type: 'requestBilling', periodStart: p.start, periodEnd: p.end, periodLabel: p.label });
    }
  };
}

function renderBilling(b) {
  if (!b) { document.getElementById('billing-section').innerHTML = ''; return; }

  const pctClass = (p) => p > 80 ? 'high' : p > 50 ? 'mid' : 'low';
  const isHistorical = !!b.isHistoricalPeriod;

  // Header: show period label and days remaining (current month only).
  let header = '<h2>Billing \u2014 ' + esc(b.plan.toUpperCase()) + ' Plan';
  if (b.periodLabel) { header += ' | ' + esc(b.periodLabel); }
  if (!isHistorical && b.daysRemaining > 0) { header += ' (' + b.daysRemaining + ' days left)'; }
  header += '</h2>';

  let html = header;
  html += '<div class="billing-grid">';

  // Activity card (informational - not billing)
  const act = b.activity || { sessions: 0, chatRequests: 0 };
  const perSession = act.sessions > 0 ? (act.chatRequests / act.sessions).toFixed(1) : '0';
  html += '<div class="billing-card">';
  html += '<h3>Activity</h3>';
  html += '<div class="headline">' + fmt(act.chatRequests) + ' <span style="font-size:0.5em;color:var(--muted)">chat requests</span></div>';
  html += '<div class="sub">' + fmt(act.sessions) + ' sessions \u00b7 ' + perSession + ' requests / session</div>';
  html += '<div class="billing-breakdown">';
  html += '<div class="row"><span>Chat requests</span><span>prompts you sent (incl. failed)</span></div>';
  html += '<div class="row"><span>Sessions</span><span>with a request or model call</span></div>';
  html += '</div></div>';

  // AI credits card (usage-based billing)
  html += '<div class="billing-card">';
  html += '<h3>AI Credits (usage-based)</h3>';
  if (isHistorical) {
    // Historical: show total credits and cost, no quota bar.
    html += '<div class="headline">' + b.new.used.toFixed(1) + ' <span style="font-size:0.5em;color:var(--muted)">credits (total)</span></div>';
    html += '<div class="sub">$' + b.new.costUSD.toFixed(2) + ' USD \u2014 quota not applicable</div>';
  } else {
    const quotaLabel = b.new.quota === null ? 'n/a' : (b.new.quota + ' credits' + (b.new.quotaIsPromotional ? ' (promo)' : ''));
    const pctLabel = b.new.pct === null ? 'quota n/a' : (b.new.pct + '% used');
    const pctWidth = b.new.pct === null ? 0 : Math.min(b.new.pct, 100);
    const pctCls = b.new.pct === null ? 'low' : pctClass(b.new.pct);
    html += '<div class="headline">' + b.new.used.toFixed(1) + ' <span style="font-size:0.5em;color:var(--muted)">/ ' + esc(quotaLabel) + '</span></div>';
    html += '<div class="sub">' + esc(pctLabel) + ' | $' + b.new.costUSD.toFixed(2) + ' USD equivalent</div>';
    html += '<div class="progress-bar"><div class="progress-fill ' + pctCls + '" style="width:' + pctWidth + '%"></div></div>';
  }
  html += '<div class="billing-breakdown">';
  html += '<div class="row" style="font-weight:600"><span>All model calls (incl. tools, subagents)</span><span>Credits</span></div>';
  for (const item of b.new.breakdown.slice(0, 4)) {
    html += '<div class="row"><span>' + esc(item.model) + '</span><span>' + item.credits.toFixed(1) + ' cr (' + fmt(item.inputTokens) + ' in / ' + fmt(item.outputTokens) + ' out)</span></div>';
  }
  html += '</div></div>';
  html += '</div>';

  html += '<div class="billing-comparison">';
  if (isHistorical) {
    html += '<div class="note">Showing period totals. Monthly quota bars are only applicable for the current billing period.</div>';
  }
  if (b.notes && b.notes.length) {
    for (const n of b.notes) {
      html += '<div class="note">[i] ' + esc(n) + '</div>';
    }
  }
  if (b.new.cachedTokensCaptured === false && !b.new.cachedTokensEstimated) {
    html += '<div class="note">[!] Cached / cache-write tokens are not present in the logs - the cost shown is an UPPER BOUND.</div>';
  } else if (b.new.cachedTokensEstimated && !b.new.cachedTokensCaptured) {
    html += '<div class="note">[~] Cached token values are ESTIMATED based on provider caching rules (prefix matching, TTL, min thresholds). Actual savings may vary.</div>';
  } else if (b.new.cachedTokensCaptured && b.new.cachedTokensEstimated) {
    html += '<div class="note">[~] Some cached token values are measured from logs; others are estimated based on provider caching rules.</div>';
  }
  html += '</div>';

  document.getElementById('billing-section').innerHTML = html;
}

function renderWorkflow(wf) {
  if (!wf || wf.turns === 0) { document.getElementById('workflow-metrics').innerHTML = '<div style="color:var(--muted);font-size:0.85em">No workflow data yet</div>'; return; }
  document.getElementById('workflow-metrics').innerHTML = [
    metric('Turns/Message', wf.turnsPerMsg),
    metric('Tools/Turn', wf.toolsPerTurn),
    metric('Tool Calls', fmt(wf.toolCalls)),
    metric('Subagents', fmt(wf.subagents)),
    metric('Errors', fmt(wf.errors)),
  ].join('');
}

function renderMetrics(a) {
  document.getElementById('overview-cards').innerHTML = [
    metric('Sessions', fmt(a.totalSessions)),
    metric('Tokens', fmt(a.totalTokens)),
    metric('Requests', fmt(a.totalRequests)),
    metric('Messages', fmt(a.totalMessages)),
    metric('Avg/Session', fmt(a.avgTokensPerSession)),
    metric('Avg/Request', fmt(a.avgTokensPerRequest)),
  ].join('');
}

function metric(label, value) {
  return '<div class="metric"><div class="label">' + esc(label) + '</div><div class="value">' + esc(String(value)) + '</div></div>';
}

function renderDailyChart(dailyStats) {
  const canvas = document.getElementById('dailyChart');
  const ctx = canvas.getContext('2d');
  const sorted = [...dailyStats].sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
  drawBarChart(ctx, canvas, sorted.map(d => d.date.slice(5)), sorted.map(d => d.total_tokens || d.totalTokens || 0));
}

function renderModelChart(modelStats) {
  const canvas = document.getElementById('modelChart');
  const ctx = canvas.getContext('2d');
  const colors = ['#4dc9f6','#f67019','#f53794','#537bc4','#acc236','#166a8f','#00a950','#58595b'];
  drawPieChart(ctx, canvas, modelStats.map(m => m.model), modelStats.map(m => m.total_tokens || m.totalTokens || 0), colors);
}

function renderTopSessions(topSessions) {
  const tbody = document.querySelector('#topSessionsTable tbody');
  tbody.innerHTML = topSessions.map(s => {
    const date = new Date(s.startTime).toLocaleDateString();
    const b = sessionBilling(s);
    return '<tr><td>' + esc(date) + '</td><td>' + fmt(s.total_tokens || s.totalTokens || 0) + '</td><td>$' + b.costUSD.toFixed(3) + '</td><td><span class="badge">' + esc(s.dominant_model || s.dominantModel || '') + '</span></td><td>' + (s.user_message_count || s.userMessageCount || 0) + '</td></tr>';
  }).join('');
}

function renderSessions(data) {
  sessionsData = data.sessions;
  renderSessionsTable();
}

function renderSessionsTable() {
  // Pre-compute virtual sort fields
  const enriched = sessionsData.map(s => {
    const b = sessionBilling(s);
    const msgs = s.user_message_count ?? s.userMessageCount ?? 0;
    return Object.assign({}, s, {
      _costJun: b.costUSD,
      _costPerMsg: msgs > 0 ? b.costUSD / msgs : 0,
      _billing: b,
    });
  });
  const sorted = enriched.sort((a, b) => {
    const aVal = a[sortCol] ?? a[toSnake(sortCol)] ?? 0;
    const bVal = b[sortCol] ?? b[toSnake(sortCol)] ?? 0;
    if (typeof aVal === 'string') return sortDir * aVal.localeCompare(bVal);
    return sortDir * (aVal - bVal);
  });
  const tbody = document.querySelector('#sessionsTable tbody');
  tbody.innerHTML = sorted.map(s => {
    const date = new Date(s.start_time || s.startTime).toLocaleString();
    const tokens = s.total_tokens ?? s.totalTokens ?? 0;
    const model = s.dominant_model || s.dominantModel || '';
    const msgs = s.user_message_count ?? s.userMessageCount ?? 0;
    const dur = fmtDur(s.duration_ms ?? s.durationMs ?? 0);
    const sid = s.id || s.session_id || '';
    const b = s._billing;
    const cpm = msgs > 0 ? '$' + (b.costUSD / msgs).toFixed(3) : '-';
    const repo = s.repository || '';
    const repoShort = repo ? (repo.split('/').pop() || repo) : '';
    const ds = s.data_source || s.dataSource || '';
    const dsBadge = ds === 'otel' ? '<span class="badge badge-otel">OTel</span>' : ds === 'hybrid' ? '<span class="badge badge-hybrid">Hyb</span>' : '';
    const audit = s.cost_audit_state || s.costAuditState || '';
    const auditBadge = audit && audit !== 'measured' ? ' <span class="badge badge-hybrid">' + esc(audit) + '</span>' : '';
    return '<tr class="clickable" data-sid="' + sid + '"><td>' + esc(date) + '</td><td>' + fmt(tokens) + '</td><td>$' + b.costUSD.toFixed(3) + auditBadge + '</td><td>' + cpm + '</td><td><span class="badge">' + esc(model) + '</span></td><td>' + (repoShort ? esc(repoShort) : '<span class="muted">-</span>') + ' ' + dsBadge + '</td><td>' + msgs + '</td><td>' + esc(dur) + '</td></tr>';
  }).join('');
  tbody.querySelectorAll('tr.clickable').forEach(row => {
    row.addEventListener('click', () => {
      vscode.postMessage({ type: 'requestSessionDetail', sessionId: row.dataset.sid });
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('sessionDetail').classList.add('active');
    });
  });
}

document.querySelectorAll('#sessionsTable th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortCol === col) { sortDir *= -1; } else { sortCol = col; sortDir = -1; }
    renderSessionsTable();
  });
});

document.getElementById('filterBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'requestSessions', groupBy: 'date', dateFrom: document.getElementById('dateFrom').value || undefined, dateTo: document.getElementById('dateTo').value || undefined });
});

document.getElementById('detailBack').addEventListener('click', () => {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('sessions').classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="sessions"]').classList.add('active');
});

function renderDetail(data) {
  const s = data.session;
  const st = data.stats;
  const a = data.analytics;
  const parts = [];

  // Session header with repo/branch badge and data source
  let headerExtra = '';
  const repo = s.repository || '';
  const branch = s.branch || '';
  if (repo) {
    const repoName = repo.split('/').pop() || repo;
    headerExtra += ' <span class="badge badge-repo" title="' + esc(repo) + '">' + esc(repoName) + (branch ? ':' + esc(branch) : '') + '</span>';
  }
  const ds = s.data_source || s.dataSource || st.data_source || st.dataSource || 'jsonl';
  const dsBadge = ds === 'otel' ? '<span class="badge badge-otel" title="High-fidelity data from OTel traces">OTel</span>'
    : ds === 'hybrid' ? '<span class="badge badge-hybrid" title="Combined OTel + JSONL data">Hybrid</span>'
    : '<span class="badge badge-jsonl" title="Parsed from JSONL debug logs">JSONL</span>';
  headerExtra += ' ' + dsBadge;

  parts.push('<h2>Session ' + esc((s.id || '').substring(0, 8)) + ' &mdash; ' + new Date(s.start_time || s.startTime).toLocaleString() + headerExtra + '</h2>');

  // Billing costs
  const b = sessionBilling(st);
  const msgs = st.user_message_count ?? st.userMessageCount ?? 0;
  const totalTok = st.total_tokens ?? st.totalTokens ?? 0;
  const costPerMsg = msgs > 0 ? (b.costUSD / msgs) : 0;

  // Summary row - the metrics that actually matter
  parts.push('<div class="metrics">');
  parts.push(metric('Cost', '$' + b.costUSD.toFixed(3)));
  parts.push(metric('Audit state', st.cost_audit_state || st.costAuditState || 'unknown'));
  parts.push(metric('Cost / Chat request', msgs > 0 ? '$' + costPerMsg.toFixed(3) : '-'));
  parts.push(metric('Chat requests', String(msgs)));
  parts.push(metric('Tokens', fmt(totalTok)));
  parts.push(metric('Duration', a ? (a.activeMinutes + ' min') : '-'));
  // Reasoning tokens (only show when present)
  if (a && a.totalReasoningTokens > 0) {
    parts.push(metric('Reasoning', fmt(a.totalReasoningTokens) + ' (' + a.reasoningPct + '%)'));
  }
  // Cache metrics
  if (a && a.totalCachedTokens > 0) {
    parts.push(metric('Cache hit rate', a.cacheHitRate + '%' + (a.dataConfidence === 'estimated' ? ' ~est' : '')));
  }
  if (a && a.cacheSavingsUSD > 0.001) {
    parts.push(metric('Cache savings', '$' + a.cacheSavingsUSD.toFixed(3)));
  }
  parts.push('</div>');

  if (a) {
    // Optimization signals (top priority)
    if (a.signals && a.signals.length > 0) {
      parts.push('<div class="signals-box">');
      for (const sig of a.signals) {
        parts.push('<div class="signal">[!] ' + esc(sig) + '</div>');
      }
      parts.push('</div>');
    }

    // Three-column analytics grid
    parts.push('<div class="analytics-grid">');

    // Column 1: Cost shape
    parts.push('<div class="analytics-col">');
    parts.push('<h3>Cost Shape</h3>');
    parts.push(statRow('Cost / message', msgs > 0 ? '$' + costPerMsg.toFixed(4) : '-'));
    parts.push(statRow('Most expensive turn', a.insights ? '$' + a.insights.expensiveTurnCost.toFixed(4) : '-'));
    parts.push(statRow('Median turn', a.insights ? '$' + a.insights.medianTurnCost.toFixed(4) : '-'));
    if (a.reasoningCostUSD > 0.001) {
      parts.push(statRow('Reasoning cost', '$' + a.reasoningCostUSD.toFixed(4) + ' (' + a.reasoningPct + '% of output)'));
    }
    if (a.cacheSavingsUSD > 0.001) {
      parts.push(statRow('Cache savings', '$' + a.cacheSavingsUSD.toFixed(4) + ' (' + a.cacheHitRate + '% hit)'));
    }
    parts.push(statRow('Wasted (errors)', a.wastedPct > 0 ? fmt(a.wastedTokens) + ' (' + a.wastedPct + '%)' : 'None'));
    parts.push(statRow('Subagent share', a.subagentPct + '%'));
    parts.push('</div>');

    // Column 2: Performance
    parts.push('<div class="analytics-col">');
    parts.push('<h3>Performance</h3>');
    parts.push(statRow('Avg TTFT', a.avgTtft + ' ms'));
    parts.push(statRow('P90 TTFT', a.p90Ttft + ' ms'));
    parts.push(statRow('Avg request time', fmtDur(a.avgRequestDuration)));
    parts.push(statRow('Error rate', a.errorRate + '%'));
    parts.push(statRow('Avg think time', a.avgThinkTime > 0 ? a.avgThinkTime + 's' : '-'));
    parts.push('</div>');

    // Column 3: Workflow shape
    parts.push('<div class="analytics-col">');
    parts.push('<h3>Workflow Shape</h3>');
    parts.push(statRow('Turns/message', String(a.turnsPerMessage)));
    parts.push(statRow('Tools/turn', String(a.toolsPerTurn)));
    parts.push(statRow('Unique tools', String(a.uniqueTools)));
    parts.push(statRow('Input/Output ratio', a.inputOutputRatio + ':1'));
    parts.push(statRow('Tokens/minute', fmt(a.tokensPerMinute)));
    parts.push('</div>');
    parts.push('</div>');

    // Model breakdown table
    if (a.modelBreakdown && a.modelBreakdown.length > 0) {
      const hasReasoning = a.modelBreakdown.some(m => m.reasoningTokens > 0);
      const hasCached = a.modelBreakdown.some(m => m.cachedTokens > 0);
      parts.push('<h2>Model Breakdown</h2>');
      parts.push('<table><thead><tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Share</th>');
      if (hasReasoning) { parts.push('<th>Reasoning</th>'); }
      if (hasCached) { parts.push('<th>Cached</th>'); }
      parts.push('</tr></thead><tbody>');
      for (const m of a.modelBreakdown) {
        parts.push('<tr><td><span class="badge">' + esc(m.model) + '</span></td><td>' + m.requests + '</td><td>' + fmt(m.tokens) + '</td><td>' + m.pct + '%</td>');
        if (hasReasoning) { parts.push('<td>' + (m.reasoningTokens > 0 ? fmt(m.reasoningTokens) : '-') + '</td>'); }
        if (hasCached) { parts.push('<td>' + (m.cachedTokens > 0 ? fmt(m.cachedTokens) : '-') + '</td>'); }
        parts.push('</tr>');
      }
      parts.push('</tbody></table>');
    }

    // Top tools table
    if (a.topTools && a.topTools.length > 0) {
      parts.push('<h2>Tool Usage</h2>');
      parts.push('<table><thead><tr><th>Tool</th><th>Calls</th><th>Avg Time</th><th>Errors</th></tr></thead><tbody>');
      for (const t of a.topTools) {
        const errBadge = t.errors > 0 ? '<span style="color:var(--danger)">' + t.errors + '</span>' : '0';
        parts.push('<tr><td>' + esc(t.name) + '</td><td>' + t.count + '</td><td>' + fmtDur(t.avgMs) + '</td><td>' + errBadge + '</td></tr>');
      }
      parts.push('</tbody></table>');
    }

    // Deep Workflow Insights
    if (a.insights) {
      const ins = a.insights;
      parts.push('<h2>Workflow Insights</h2>');
      parts.push('<div class="analytics-grid">');

      // Column 1: Tool taxonomy
      parts.push('<div class="analytics-col">');
      parts.push('<h3>What Tools Did</h3>');
      const totalCalls = ins.explorationCalls + ins.productionCalls + ins.metaCalls;
      const prodPct = totalCalls > 0 ? Math.round((ins.productionCalls / totalCalls) * 100) : 0;
      const metaPct = totalCalls > 0 ? Math.round((ins.metaCalls / totalCalls) * 100) : 0;
      parts.push(statRow('Production (edits/runs)', ins.productionCalls + ' (' + prodPct + '%)'));
      parts.push(statRow('Exploration (read/search)', ins.explorationCalls + ' (' + ins.explorationPct + '%)'));
      parts.push(statRow('Meta (todo/memory)', ins.metaCalls + ' (' + metaPct + '%)'));
      parts.push(statRow('Productive turn tokens', fmt(ins.productionTokens)));
      parts.push(statRow('Non-productive tokens', fmt(ins.explorationTokens)));
      // 3-way bar
      parts.push('<div class="insight-bar">');
      parts.push('<div class="insight-bar-fill prod" style="width:' + prodPct + '%" title="Production ' + prodPct + '%"></div>');
      parts.push('<div class="insight-bar-fill expl" style="width:' + ins.explorationPct + '%" title="Exploration ' + ins.explorationPct + '%"></div>');
      parts.push('<div class="insight-bar-fill meta" style="width:' + metaPct + '%" title="Meta ' + metaPct + '%"></div>');
      parts.push('</div>');
      parts.push('<div class="insight-bar-labels"><span>Prod ' + prodPct + '%</span><span>Expl ' + ins.explorationPct + '%</span><span>Meta ' + metaPct + '%</span></div>');
      parts.push('</div>');

      // Column 2: Context dynamics
      parts.push('<div class="analytics-col">');
      parts.push('<h3>Context Dynamics</h3>');
      parts.push(statRow('Avg growth/turn', '+' + fmt(ins.avgContextGrowthPerTurn) + ' tok'));
      parts.push(statRow('Peak context', fmt(ins.maxContextReached) + ' tok'));
      parts.push(statRow('Utilization', ins.contextUtilizationPct + '% of capacity'));
      parts.push(statRow('Saturation turn', ins.contextSaturationTurn > 0 ? '#' + ins.contextSaturationTurn : 'Never'));
      parts.push(statRow('Bloat ratio', ins.bloatRatio > 0 ? ins.bloatRatio + 'x (late vs early)' : '-'));
      const utilPct = Math.min(ins.contextUtilizationPct, 100);
      const utilClass = utilPct > 80 ? 'high' : utilPct > 50 ? 'mid' : 'low';
      parts.push('<div class="insight-bar"><div class="insight-bar-fill ctx-' + utilClass + '" style="width:' + utilPct + '%"></div></div>');
      parts.push('<div class="insight-bar-labels"><span>0%</span><span>Context window</span><span>100%</span></div>');
      parts.push('</div>');

      // Column 3: Cost efficiency (the actionable column)
      parts.push('<div class="analytics-col">');
      parts.push('<h3>Cost Efficiency</h3>');
      const meEff = ins.marginalEfficiencyPct;
      const meCls = meEff > 30 ? 'eff-good' : meEff > 15 ? 'eff-normal' : 'eff-bad';
      parts.push(statRow('Total cost', '$' + b.costUSD.toFixed(3)));
      parts.push(statRow('New-work cost', '$' + ins.totalMarginalCost.toFixed(3)));
      parts.push('<div class="stat-row"><span class="stat-label">Marginal efficiency</span><span class="stat-value ' + meCls + '">' + meEff + '% new vs re-billed</span></div>');
      // Reasoning breakdown in cost efficiency
      if (a.totalReasoningTokens > 0) {
        parts.push(statRow('Reasoning cost', '$' + a.reasoningCostUSD.toFixed(4) + ' (' + a.reasoningPct + '% of output)'));
      }
      if (a.cacheSavingsUSD > 0.001) {
        parts.push('<div class="stat-row"><span class="stat-label">Cache savings</span><span class="stat-value eff-good">-$' + a.cacheSavingsUSD.toFixed(4) + '</span></div>');
      }
      if (ins.stallSequences > 0) {
        parts.push(statRow('Stall events', ins.stallSequences + ' (longest: ' + ins.longestStall + ' turns)'));
        parts.push('<div class="stat-row"><span class="stat-label">Stall waste</span><span class="stat-value eff-bad">' + fmt(ins.stallTokens) + ' tokens</span></div>');
      } else {
        parts.push('<div class="stat-row"><span class="stat-label">Stall events</span><span class="stat-value eff-good">None</span></div>');
      }
      parts.push('</div>');
      parts.push('</div>');

      // Per-message breakdown - REAL timestamp-based attribution
      if (ins.promptEfficiency && ins.promptEfficiency.length > 0) {
        parts.push('<h2>Per-Message Breakdown</h2>');
        parts.push('<table><thead><tr><th>#</th><th>Prompt</th><th>Turns</th><th>Productive</th><th>Tokens</th><th>Cost</th><th>Verdict</th></tr></thead><tbody>');
        for (let pi = 0; pi < ins.promptEfficiency.length; pi++) {
          const pe = ins.promptEfficiency[pi];
          const prodRatio = pe.turnsAfter > 0 ? pe.productiveTurns / pe.turnsAfter : 0;
          let verdict, vCls;
          if (pe.turnsAfter === 0) { verdict = 'Skipped'; vCls = 'eff-normal'; }
          else if (pe.turnsAfter <= 3 && prodRatio >= 0.5) { verdict = 'Efficient'; vCls = 'eff-good'; }
          else if (pe.turnsAfter > 15 || prodRatio < 0.3) { verdict = 'Wasteful'; vCls = 'eff-bad'; }
          else { verdict = 'Normal'; vCls = 'eff-normal'; }
          parts.push('<tr><td>' + (pi + 1) + '</td><td>' + pe.msgLength + ' ch</td><td>' + pe.turnsAfter + '</td><td>' + pe.productiveTurns + '/' + pe.turnsAfter + '</td><td>' + fmt(pe.tokensAfter) + '</td><td>$' + pe.costAfter.toFixed(4) + '</td><td><span class="' + vCls + '">' + verdict + '</span></td></tr>');
        }
        parts.push('</tbody></table>');
      }
    }
  }

  // Request timeline - enriched
  parts.push('<h2>Request Timeline</h2>');

  // Build interleaved timeline
  const timeline = [];
  for (const r of data.requests) {
    timeline.push({ type: 'llm', ts: r.timestamp, data: r });
  }
  if (data.messages) {
    for (const m of data.messages) {
      timeline.push({ type: 'msg', ts: m.timestamp, data: m });
    }
  }
  if (data.toolCalls) {
    for (const t of data.toolCalls) {
      timeline.push({ type: 'tool', ts: t.timestamp || t.ts, data: t });
    }
  }
  timeline.sort((a, b) => a.ts - b.ts);

  // Pre-process: group tool calls before each LLM turn
  const processedTimeline = [];
  let pendingTools = [];
  for (const ev of timeline) {
    if (ev.type === 'tool') {
      pendingTools.push(ev.data);
    } else {
      if (pendingTools.length > 0) {
        processedTimeline.push({ type: 'toolgroup', ts: pendingTools[0].timestamp || pendingTools[0].ts, tools: [...pendingTools] });
        pendingTools = [];
      }
      processedTimeline.push(ev);
    }
  }
  if (pendingTools.length > 0) {
    processedTimeline.push({ type: 'toolgroup', ts: pendingTools[0].timestamp || pendingTools[0].ts, tools: [...pendingTools] });
  }

  // Action classification helper
  function classifyAction(outTok, toolsBefore, toolsAfter) {
    // Based on output size and surrounding tool context
    if (outTok < 80) return { label: 'Routing', cls: 'act-route', desc: 'Deciding next action' };
    if (outTok < 300) {
      // Check what tools are around
      const hasEdit = toolsAfter.some(t => (t.tool_name||t.toolName||'').match(/replace|create_file|multi_replace/));
      const hasSearch = toolsBefore.some(t => (t.tool_name||t.toolName||'').match(/read_file|grep|semantic|file_search/));
      if (hasEdit) return { label: 'Planning edit', cls: 'act-plan', desc: 'Preparing code change' };
      if (hasSearch) return { label: 'Analyzing', cls: 'act-analyze', desc: 'Processing search results' };
      return { label: 'Reasoning', cls: 'act-reason', desc: 'Thinking through approach' };
    }
    if (outTok < 2000) {
      const hasEdit = toolsAfter.some(t => (t.tool_name||t.toolName||'').match(/replace|create_file|multi_replace/));
      if (hasEdit) return { label: 'Editing', cls: 'act-edit', desc: 'Making code changes' };
      return { label: 'Responding', cls: 'act-respond', desc: 'Generating response' };
    }
    return { label: 'Generating', cls: 'act-generate', desc: 'Large code generation' };
  }

  // Compute running totals and render
  let runningTokens = 0;
  let runningCredits = 0;
  let turnIndex = 0;
  let prevTs = 0;
  let prevInputTok = 0;

  const kv = (k, v) => '<div class="tl-kv"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';

  parts.push('<div class="timeline">');

  for (let idx = 0; idx < processedTimeline.length; idx++) {
    const ev = processedTimeline[idx];

    if (ev.type === 'msg') {
      const m = ev.data;
      const preview = m.content_preview || m.contentPreview || '';
      const len = m.content_length || m.contentLength || 0;
      const spanId = m.span_id || m.spanId || '';
      parts.push('<details class="tl-msg">');
      parts.push('<summary><span class="tl-badge tl-badge-msg">USER</span> ');
      parts.push('<span class="tl-text">' + esc(preview.substring(0, 150)) + (preview.length > 150 ? '…' : '') + '</span>');
      parts.push('<span class="tl-meta"> ' + new Date(ev.ts).toLocaleTimeString() + ' | ' + len + ' chars</span><span class="chev"></span></summary>');
      parts.push('<div class="tl-expand">');
      const fullMsg = m.content_full || m.contentFull || preview;
      parts.push('<div class="tl-full">' + esc(fullMsg) + '</div>');
      if (len > fullMsg.length) {
        parts.push('<div class="tl-meta">Showing the first ' + fmt(fullMsg.length) + ' of ' + fmt(len) + ' characters (field is capped). Re-sync after clearing cache if this is an older session.</div>');
      }
      parts.push(kv('Time', esc(new Date(ev.ts).toLocaleString())));
      parts.push(kv('Length', len + ' chars'));
      if (spanId) { parts.push(kv('Span ID', esc(spanId))); }
      parts.push('</div></details>');
      turnIndex = 0;
      prevInputTok = 0;

    } else if (ev.type === 'toolgroup') {
      const tools = ev.tools;
      // Group by tool name
      const grouped = {};
      let totalDur = 0;
      let errors = 0;
      for (const t of tools) {
        const name = t.tool_name || t.toolName || 'unknown';
        const dur = t.duration || 0;
        totalDur += dur;
        if (t.status === 'error') errors++;
        if (!grouped[name]) grouped[name] = { count: 0, dur: 0, errors: 0 };
        grouped[name].count++;
        grouped[name].dur += dur;
        if (t.status === 'error') grouped[name].errors++;
      }
      const errMark = errors > 0 ? ' tl-error' : '';
      const toolSummary = Object.entries(grouped).map(([name, v]) => {
        const e = v.errors > 0 ? ' <span style="color:var(--danger)">[' + v.errors + ' failed]</span>' : '';
        return esc(name) + (v.count > 1 ? ' x' + v.count : '') + (v.dur > 1000 ? ' (' + fmtDur(v.dur) + ')' : '') + e;
      }).join(', ');

      parts.push('<details class="tl-toolgroup' + errMark + '">');
      parts.push('<summary><span class="tl-badge tl-badge-tool">TOOLS</span> ');
      parts.push('<span class="tl-tools-inline">' + toolSummary + '</span>');
      if (totalDur > 1000) { parts.push('<span class="tl-meta"> | Total: ' + fmtDur(totalDur) + '</span>'); }
      parts.push('<span class="tl-expand-hint">' + tools.length + ' call' + (tools.length > 1 ? 's' : '') + '</span><span class="chev"></span></summary>');

      // Expanded: every individual tool call with full metadata.
      parts.push('<div class="tl-expand"><div class="tl-toollist">');
      for (const t of tools) {
        const tn = esc(t.tool_name || t.toolName || 'unknown');
        const isErr = t.status === 'error';
        const dur = t.duration || 0;
        const tType = t.tool_type || t.toolType || '';
        const tCallId = t.tool_call_id || t.toolCallId || '';
        const tTs = t.timestamp || t.ts || 0;
        parts.push('<div class="tl-toolrow"><span class="tname">' + tn + '</span>');
        parts.push('<span class="tstatus' + (isErr ? ' err' : '') + '">' + (isErr ? 'error' : 'ok') + '</span>');
        parts.push('<span class="tdur">' + (dur > 0 ? fmtDur(dur) : '—') + '</span></div>');
        const sub = [];
        if (tTs) { sub.push(new Date(tTs).toLocaleTimeString()); }
        if (tType) { sub.push('type: ' + esc(tType)); }
        if (tCallId) { sub.push('id: ' + esc(tCallId)); }
        if (t.is_subagent || t.isSubagent) { sub.push('subagent'); }
        parts.push('<div class="tl-toolsub">' + (sub.length ? sub.join(' &middot; ') : '&nbsp;') + '</div>');
        // Input (command / script / file edit) and the output it produced.
        const tArgs = t.args || '';
        const tResult = t.result || t.errorText || '';
        if (tArgs) { parts.push('<div class="tl-meta">input:</div><div class="tl-full">' + esc(tArgs) + '</div>'); }
        if (tResult) { parts.push('<div class="tl-meta">output' + (isErr ? ' (error)' : '') + ':</div><div class="tl-full">' + esc(tResult) + '</div>'); }
      }
      parts.push('</div></div></details>');

    } else if (ev.type === 'llm') {
      turnIndex++;
      const r = ev.data;
      const inTok = r.input_tokens || r.inputTokens || 0;
      const outTok = r.output_tokens || r.outputTokens || 0;
      const total = inTok + outTok;
      runningTokens += total;
      const cachedTok = r.cached_input_tokens ?? r.cachedInputTokens ?? 0;
      const cwTok = r.cache_write_tokens ?? r.cacheWriteTokens ?? 0;
      const reasoningTok = r.reasoning_tokens ?? r.reasoningTokens ?? 0;
      const respModel = r.response_model ?? r.responseModel ?? '';
      // Computed by the extension: billed amount when reported, else list price.
      const costUSD = (typeof r.costUSD === 'number') ? r.costUSD : 0;
      const listCostUSD = (typeof r.listCostUSD === 'number') ? r.listCostUSD : 0;
      runningCredits += costUSD;
      const ttft = r.ttft || 0;
      const dur = r.duration || r.dur || 0;
      const gap = prevTs > 0 ? Math.round((ev.ts - prevTs) / 1000) : 0;
      prevTs = ev.ts + dur;

      // Context delta
      const inputDelta = prevInputTok > 0 ? inTok - prevInputTok : 0;
      prevInputTok = inTok;

      // Classify action by looking at tools before and after this LLM call
      const toolsBefore = (idx > 0 && processedTimeline[idx-1].type === 'toolgroup') ? processedTimeline[idx-1].tools : [];
      const toolsAfter = (idx < processedTimeline.length-1 && processedTimeline[idx+1].type === 'toolgroup') ? processedTimeline[idx+1].tools : [];
      const action = classifyAction(outTok, toolsBefore, toolsAfter);

      const isSub = r.is_subagent || r.isSubagent;
      const badgeClass = isSub ? 'tl-badge-sub' : 'tl-badge-llm';
      const badgeText = isSub ? 'SUB' : 'LLM';
      const subName = r.subagent_name || r.subagentName || '';
      const errClass = r.status === 'error' ? ' tl-error' : '';

      parts.push('<div class="tl-llm' + errClass + '">');

      // Classify productivity: did this turn produce real progress?
      const PROD_TOOLS = /replace|create_file|multi_replace|run_in_terminal|send_to_terminal|vscode_renameSymbol|edit_notebook/;
      const hasProductionTool = toolsAfter.some(t => (t.tool_name||t.toolName||'').match(PROD_TOOLS));
      const isProductive = hasProductionTool || outTok >= 150;

      // Marginal cost: cost of NEW input tokens (delta) + output. The rest is re-billed context from prior turns.
      const newInput = turnIndex === 1 ? inTok : Math.max(0, inputDelta);
      // Priced at this prompt's list rates, scaled by billed/list so it stays a
      // consistent share of what the turn actually cost.
      const marginalList = (newInput * (r.rateInput || 0) + outTok * (r.rateOutput || 0)) / 1_000_000;
      const marginalCost = listCostUSD > 0 ? marginalList * (costUSD / listCostUSD) : marginalList;
      const marginalPct = costUSD > 0 ? Math.round((marginalCost / costUSD) * 100) : 0;

      // Header line: badge, turn#, model, action tag
      parts.push('<div class="tl-llm-header">');
      parts.push('<span class="tl-badge ' + badgeClass + '">' + badgeText + ' #' + turnIndex + '</span>');
      const modelLabel = respModel && respModel !== r.model ? esc(r.model) + ' ? ' + esc(respModel) : esc(r.model);
      parts.push('<span class="tl-model">' + modelLabel + (subName ? ' [' + esc(subName) + ']' : '') + '</span>');
      parts.push('<span class="tl-action ' + action.cls + '" title="' + esc(action.desc) + '">' + action.label + '</span>');
      if (!isProductive) { parts.push('<span class="tl-eff-tag tl-eff-exploration" title="No edits and minimal output - likely exploration or stall">non-productive</span>'); }
      if (r.status === 'error') { parts.push('<span class="tl-err-tag">ERROR</span>'); }
      parts.push('</div>');

      // Token detail line
      parts.push('<div class="tl-detail">');
      parts.push('<span>' + fmt(inTok) + ' in / ' + fmt(outTok) + ' out');
      if (reasoningTok > 0) { parts.push(' <span class="tl-reasoning" title="Reasoning/thinking tokens (included in output)">[' + fmt(reasoningTok) + ' reasoning]</span>'); }
      if (cachedTok > 0) { parts.push(' <span class="tl-cached" title="Cached input tokens (reduced cost)">[' + fmt(cachedTok) + ' cached]</span>'); }
      if (inputDelta > 0) { parts.push(' <span class="tl-delta">(+' + fmt(inputDelta) + ' new ctx)</span>'); }
      parts.push('</span>');
      parts.push('<span class="tl-cost">$' + costUSD.toFixed(4) + '</span>');
      parts.push('</div>');

      // Marginal efficiency line - the actually meaningful per-turn metric
      parts.push('<div class="tl-efficiency">');
      const mcCls = marginalPct > 30 ? 'tl-eff-good' : marginalPct > 10 ? 'tl-eff-item' : 'tl-eff-warn';
      parts.push('<span class="tl-eff-item" title="Cost of NEW tokens this turn (delta input + output). The rest is re-billed context from previous turns. Higher = this turn paid for itself with new work.">New-work cost: <span class="' + mcCls + '">$' + marginalCost.toFixed(4) + ' (' + marginalPct + '% of turn)</span></span>');
      parts.push('</div>');

      // Performance line
      parts.push('<div class="tl-meta">');
      parts.push(new Date(ev.ts).toLocaleTimeString());
      parts.push(' | TTFT: ' + ttft + 'ms');
      parts.push(' | Duration: ' + fmtDur(dur));
      parts.push(' | ' + (dur > 0 ? Math.round(outTok / (dur / 1000)) : 0) + ' tok/s');
      if (gap > 2) { parts.push(' | <span class="tl-gap">Gap ' + fmtDur(gap * 1000) + '</span>'); }
      parts.push('</div>');

      // Running total
      parts.push('<div class="tl-running">' + fmt(runningTokens) + ' tokens cumulative | $' + runningCredits.toFixed(3) + ' total spend</div>');

      // Expandable raw detail — every persisted field for this request.
      const srcIn = r.input_tokens_source || r.inputTokensSource || '';
      const srcOut = r.output_tokens_source || r.outputTokensSource || '';
      const srcCached = r.cached_input_tokens_source || r.cachedInputTokensSource || '';
      const srcCw = r.cache_write_tokens_source || r.cacheWriteTokensSource || '';
      const maxTok = r.max_tokens ?? r.maxTokens ?? 0;
      const traceId = r.trace_id || r.traceId || '';
      const convId = r.conversation_id || r.conversationId || '';
      const spanId = r.span_id || r.spanId || '';
      const parentSpan = r.parent_span_id || r.parentSpanId || '';
      const directCredits = r.direct_credits ?? r.directCredits;
      const auditFlags = r.token_audit_flags || r.tokenAuditFlags || [];
      const promptPreview = r.user_request_preview || r.userRequestPreview || '';
      const src = (s) => s ? ' <span style="color:var(--muted)">(' + esc(s) + ')</span>' : '';
      const outText = r.output_text || r.outputText || '';
      const reasonText = r.reasoning_text || r.reasoningText || '';
      parts.push('<details class="tl-raw"><summary>Output &amp; request details<span class="chev"></span></summary><div class="tl-expand">');
      if (outText) { parts.push('<div class="tl-meta">Generated output:</div><div class="tl-full">' + esc(outText) + '</div>'); }
      if (reasonText) { parts.push('<div class="tl-meta">Reasoning / thinking:</div><div class="tl-full">' + esc(reasonText) + '</div>'); }
      parts.push(kv('Model requested', esc(r.model || '')));
      if (respModel && respModel !== r.model) { parts.push(kv('Model responded', esc(respModel))); }
      parts.push(kv('Input tokens', fmt(inTok) + src(srcIn)));
      parts.push(kv('Output tokens', fmt(outTok) + src(srcOut)));
      if (cachedTok > 0) { parts.push(kv('Cached input', fmt(cachedTok) + src(srcCached))); }
      if (cwTok > 0) { parts.push(kv('Cache write', fmt(cwTok) + src(srcCw))); }
      if (reasoningTok > 0) { parts.push(kv('Reasoning', fmt(reasoningTok))); }
      if (maxTok > 0) { parts.push(kv('Max tokens', fmt(maxTok))); }
      parts.push(kv('Cost', '$' + costUSD.toFixed(4)));
      parts.push(kv('New-work cost', '$' + marginalCost.toFixed(4) + ' (' + marginalPct + '%)'));
      parts.push(kv('TTFT', ttft + ' ms'));
      parts.push(kv('Duration', fmtDur(dur)));
      parts.push(kv('Status', esc(r.status || '') + (r.error ? ': ' + esc(String(r.error)) : '')));
      if (directCredits !== undefined && directCredits !== null) { parts.push(kv('Direct credits (API)', Number(directCredits).toFixed(4))); }
      if (spanId) { parts.push(kv('Span ID', esc(spanId))); }
      if (parentSpan) { parts.push(kv('Parent span', esc(parentSpan))); }
      if (traceId) { parts.push(kv('Trace ID', esc(traceId))); }
      if (convId) { parts.push(kv('Conversation', esc(convId))); }
      if (auditFlags && auditFlags.length) { parts.push(kv('Audit flags', esc(auditFlags.join(', ')))); }
      if (promptPreview) { parts.push('<div class="tl-meta" style="margin-top:6px">Prompt preview:</div><div class="tl-full">' + esc(promptPreview) + '</div>'); }
      parts.push('</div></details>');

      parts.push('</div>');
    }
  }
  parts.push('</div>');

  // Legend
  parts.push('<details class="legend"><summary>Legend - What these metrics mean</summary><dl>');
  parts.push('<dt>Cost / Message</dt><dd>Total session cost divided by number of user messages. The single best metric to compare across sessions - what each prompt actually cost in dollars.</dd>');
  parts.push('<dt>New-work cost (Timeline)</dt><dd>Cost attributable to NEW tokens this turn (delta input from previous turn + this turn output). The remaining cost is re-billed context that was already paid for in earlier turns. The percentage shows how much of the turn was actual new work vs re-processing.</dd>');
  parts.push('<dt>Marginal Efficiency</dt><dd>Session-wide ratio: cost of new tokens vs total cost. High (>30%) = mostly doing new work. Low (<15%) = lots of money spent on re-billed context, suggesting the conversation is too long or context-heavy.</dd>');
  parts.push('<dt>Bloat Ratio</dt><dd>Cost of the second half of turns divided by cost of the first half. 1.0 = balanced. 2-3x = normal context growth. >3x = the conversation got bloated and late turns were much more expensive than early ones.</dd>');
  parts.push('<dt>Production / Exploration / Meta tools</dt><dd>Production = makes changes (edits, runs commands). Exploration = gathers info (read, search). Meta = housekeeping (todo lists, memory, subagent calls). A healthy session has a mix; high exploration without production suggests over-investigation.</dd>');
  parts.push('<dt>Non-productive turn (Timeline)</dt><dd>A turn that produced no edits and less than 150 output tokens. Usually routing or short reasoning between tool calls. Several in a row form a stall.</dd>');
  parts.push('<dt>Stall Events</dt><dd>3+ consecutive non-productive turns - the agent looping through searches/reads without making progress. Stall waste shows the tokens consumed during these loops.</dd>');
  parts.push('<dt>Context Saturation Turn</dt><dd>The turn number where input first exceeded 80% of model capacity. After this point, every turn pays the maximum context cost.</dd>');
  parts.push('<dt>TTFT / P90 TTFT</dt><dd>Time To First Token - how fast the model started responding. P90 = 90th percentile (worst-case latency). High P90 with normal avg = occasional slowdowns.</dd>');
  parts.push('<dt>Turns/Message</dt><dd>Average agent loop iterations per user prompt. >8 suggests the agent is over-iterating; consider more specific prompts.</dd>');
  parts.push('<dt>Tools/Turn</dt><dd>Average tool invocations per turn. ~1.0 is typical; higher means parallel tool use.</dd>');
  parts.push('<dt>Input/Output Ratio</dt><dd>Total input vs output tokens. >15:1 = context-heavy; ~1:1 = generative tasks.</dd>');
  parts.push('<dt>Wasted Tokens</dt><dd>Tokens consumed by failed requests (errors, refusals). Pure cost with no value.</dd>');
  parts.push('<dt>Subagent Tokens</dt><dd>Tokens consumed by delegated sub-agents. Billed like any other model call.</dd>');
  parts.push('<dt>Reasoning Tokens</dt><dd>Tokens the model used for internal "thinking" (chain-of-thought). Already included in output token count and billed at output rate. High reasoning relative to visible output means the model is over-thinking. Only available from OTel data source.</dd>');
  parts.push('<dt>Cache Hit Rate</dt><dd>Percentage of input tokens served from cache. Cache hits are billed at a much lower rate (typically 10% of input). Higher is better. "~est" means the value is estimated from heuristics, not measured.</dd>');
  parts.push('<dt>Cache Savings</dt><dd>Dollar amount saved by cache hits vs paying full input price. Calculated as cached_tokens × (input_price - cached_price) per model.</dd>');
  parts.push('<dt>Data Source Badge</dt><dd>OTel = high-fidelity data from VS Code agent traces (real cached/reasoning tokens). JSONL = parsed from debug logs (estimated cache values). Hybrid = combined from both sources.</dd>');
  parts.push('<dt>Model Routing (?)</dt><dd>When the response model differs from the requested model, shown as "requested ? actual" in the timeline. Usually indicates capacity constraints or automatic fallback.</dd>');
  parts.push('<dt>Verdict (Per-Message Table)</dt><dd>Efficient = at most 3 turns and at least 50% productive. Wasteful = more than 15 turns OR less than 30% productive turns. Normal = anything in between.</dd>');
  parts.push('</dl></details>');

  document.getElementById('detailContent').innerHTML = parts.join('');
}

function statRow(label, value) {
  return '<div class="stat-row"><span class="stat-label">' + esc(label) + '</span><span class="stat-value">' + esc(String(value)) + '</span></div>';
}

function drawBarChart(ctx, canvas, labels, values) {
  const w = canvas.width = canvas.parentElement.clientWidth - 32;
  const h = canvas.height = 220;
  const max = Math.max(...values, 1);
  const barW = Math.max(4, (w - 50) / labels.length - 3);
  ctx.clearRect(0, 0, w, h);
  const accentColor = getComputedStyle(document.body).getPropertyValue('--vscode-textLink-foreground') || '#4dc9f6';
  const mutedColor = getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground') || '#888';

  for (let i = 0; i < labels.length; i++) {
    const x = 40 + i * (barW + 3);
    const barH = (values[i] / max) * (h - 35);
    ctx.fillStyle = accentColor;
    ctx.fillRect(x, h - 20 - barH, barW, barH);
    ctx.fillStyle = mutedColor;
    ctx.font = '9px sans-serif';
    ctx.save();
    ctx.translate(x + barW / 2, h - 4);
    ctx.rotate(-0.7);
    ctx.fillText(labels[i], 0, 0);
    ctx.restore();
  }
}

function drawPieChart(ctx, canvas, labels, values, colors) {
  const w = canvas.width = canvas.parentElement.clientWidth - 32;
  const h = canvas.height = 180;
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = h / 2 + 10;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 8;
  let angle = -Math.PI / 2;
  ctx.clearRect(0, 0, w, h);

  for (let i = 0; i < values.length; i++) {
    const slice = (values[i] / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();
    angle += slice;
  }
  const lx = h + 20;
  ctx.font = '11px sans-serif';
  const fgColor = getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground') || '#ccc';
  for (let i = 0; i < labels.length; i++) {
    const y = 16 + i * 18;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(lx, y - 8, 10, 10);
    ctx.fillStyle = fgColor;
    ctx.fillText(labels[i] + ' (' + Math.round(values[i] / total * 100) + '%)', lx + 16, y + 1);
  }
}

function fmt(n) { return (n || 0).toLocaleString(); }
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function fmtDur(ms) {
  if (!ms) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function toSnake(s) { return s.replace(/([A-Z])/g, '_$1').toLowerCase(); }
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
