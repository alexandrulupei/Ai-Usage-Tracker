import * as vscode from 'vscode';
import { TrackerDatabase } from '../../db/database';
import { SessionInfo, SessionStats, ProviderId } from '../../core/types';
import { formatTokens, formatDateTime, getDateGroup, formatDuration } from '../../util/dateUtils';
import { computeBillingStatus, computeCostUSD, getBillingPeriodBounds, computeClaudeBilling } from '../../stats/billingCalculator';
import { getConfig } from '../../config';

type TreeItemData =
  | { kind: 'providerHeader'; provider: ProviderId }                            // colored active-provider row (click to switch)
  | { kind: 'group'; label: string; sessions: (SessionInfo & SessionStats)[] }
  | { kind: 'session'; data: SessionInfo & SessionStats }
  | { kind: 'stat'; label: string; value: string }                              // kept for SessionTreeProvider
  | { kind: 'section'; label: string }                                          // non-interactive section divider
  | { kind: 'metric'; label: string; value: string; icon: string; tooltip?: string } // icon + label + grey description
  | { kind: 'picker'; label: string; description: string; tooltip: string }    // month QuickPick trigger
  | { kind: 'tip'; label: string }                                              // lightbulb tip row
  | { kind: 'action'; label: string; command: string; icon?: string };         // primary action row

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeItemData> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItemData | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private activeProvider: ProviderId = 'copilot';

  constructor(private db: TrackerDatabase) {}

  setActiveProvider(provider: ProviderId): void {
    this.activeProvider = provider;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItemData): vscode.TreeItem {
    switch (element.kind) {
      case 'providerHeader':
        return providerHeaderItem(element.provider);

      case 'group': {
        const item = new vscode.TreeItem(
          `${element.label} (${element.sessions.length})`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon('calendar');
        return item;
      }

      case 'session': {
        const s = element.data;
        const time = new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const tokens = s.totalTokens > 0 ? `${formatTokens(s.totalTokens)} tokens` : 'empty';
        const model = s.dominantModel ? ` (${shortModelName(s.dominantModel)})` : '';
        const ds = s.dataSource || '';
        const dsBadge = ds === 'otel' ? ' [OTel]' : ds === 'hybrid' ? ' [Hyb]' : '';
        const audit = s.costAuditState && s.costAuditState !== 'measured' ? ` [${s.costAuditState}]` : '';
        const label = `${time} - ${tokens}${model}${dsBadge}${audit}`;

        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'session';
        const tooltipLines = [
          `**Session** ${s.id.substring(0, 8)}`,
          `**Started** ${formatDateTime(s.startTime)}`,
          `**Duration** ${formatDuration(s.durationMs)}`,
          `**Tokens** ${formatTokens(s.totalTokens)} (in: ${formatTokens(s.totalInputTokens)}, out: ${formatTokens(s.totalOutputTokens)})`,
          `**Cost** $${(s.costUSD ?? 0).toFixed(3)}${s.costAuditState ? ` (${s.costAuditState})` : ''}`,
          `**Chat requests** ${s.userMessageCount} | **Model calls** ${s.llmRequestCount} | **Tools** ${s.toolCallCount}`,
          `**Model** ${s.dominantModel}`,
          `**Errors** ${s.errorCount}`,
        ];
        if (s.repository) {
          tooltipLines.push(`**Repository** ${s.repository}${s.branch ? `:${s.branch}` : ''}`);
        }
        if (s.dataSource) {
          tooltipLines.push(`**Data source** ${s.dataSource === 'otel' ? 'OTel (measured)' : s.dataSource === 'hybrid' ? 'Hybrid' : 'JSONL (estimated)'}`);
        }
        if (s.totalReasoningTokens && s.totalReasoningTokens > 0) {
          tooltipLines.push(`**Reasoning** ${formatTokens(s.totalReasoningTokens)} tokens`);
        }
        if (s.totalCachedTokens && s.totalCachedTokens > 0) {
          tooltipLines.push(`**Cached** ${formatTokens(s.totalCachedTokens)} tokens`);
        }
        if (s.totalCacheWriteTokens && s.totalCacheWriteTokens > 0) {
          tooltipLines.push(`**Cache write** ${formatTokens(s.totalCacheWriteTokens)} tokens`);
        }
        if (s.costAuditFlags && s.costAuditFlags.length > 0) {
          tooltipLines.push(`**Audit flags** ${s.costAuditFlags.slice(0, 5).join(', ')}`);
        }
        item.tooltip = new vscode.MarkdownString(tooltipLines.join('\n\n'));
        item.iconPath = s.totalTokens > 0
          ? new vscode.ThemeIcon('comment-discussion')
          : new vscode.ThemeIcon('circle-outline');
        // Store session id for commands
        item.id = s.id;
        return item;
      }

      case 'stat': {
        const item = new vscode.TreeItem(`${element.label}: ${element.value}`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('graph');
        return item;
      }

      case 'action': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.command = { command: element.command, title: element.label };
        item.iconPath = new vscode.ThemeIcon('link-external');
        return item;
      }
      default:
        return new vscode.TreeItem('');
    }
  }

  getChildren(element?: TreeItemData): TreeItemData[] {
    if (!element) {
      return this.getRootChildren();
    }

    if (element.kind === 'group') {
      return element.sessions.map(s => ({ kind: 'session' as const, data: s }));
    }

    if (element.kind === 'session') {
      return this.getSessionChildren(element.data);
    }

    return [];
  }

  private getRootChildren(): TreeItemData[] {
    const sessions = this.db.getSessionsWithStats(undefined, undefined, this.activeProvider);

    // Group by date
    const groups = new Map<string, (SessionInfo & SessionStats)[]>();
    for (const s of sessions) {
      const group = getDateGroup(s.startTime);
      if (!groups.has(group)) { groups.set(group, []); }
      groups.get(group)!.push(s);
    }

    const items: TreeItemData[] = [{ kind: 'providerHeader', provider: this.activeProvider }];
    for (const [label, groupSessions] of groups) {
      items.push({ kind: 'group', label, sessions: groupSessions });
    }

    if (groups.size === 0) {
      items.push({ kind: 'stat', label: 'No sessions found', value: 'Click refresh to scan logs' });
    }

    return items;
  }

  private getSessionChildren(s: SessionInfo & SessionStats): TreeItemData[] {
    const isClaude = (s.provider ?? this.activeProvider) === 'claude';
    const costUSD = s.costUSD ?? 0;

    const items: TreeItemData[] = [];
    if (isClaude) {
      // Claude: USD only — no AI credits (a GitHub concept).
      items.push({ kind: 'stat', label: 'Cost (USD)', value: `$${costUSD.toFixed(3)}` });
    } else {
      const credits = Math.round(costUSD * 100 * 10) / 10; // 1 credit = $0.01
      items.push({ kind: 'stat', label: 'Cost', value: `$${costUSD.toFixed(3)} (${credits} cr)` });
    }
    items.push(
      { kind: 'stat', label: 'Audit state', value: s.costAuditState || 'unknown' },
      { kind: 'stat', label: 'Tokens', value: `${formatTokens(s.totalInputTokens)} in / ${formatTokens(s.totalOutputTokens)} out` },
      { kind: 'stat', label: 'Chat requests', value: String(s.userMessageCount) },
      { kind: 'stat', label: 'Model calls', value: String(s.llmRequestCount) },
      { kind: 'stat', label: 'Tool calls', value: String(s.toolCallCount) },
      { kind: 'stat', label: 'Turns', value: String(s.turnCount) },
      { kind: 'stat', label: 'Duration', value: formatDuration(s.durationMs) },
    );
    if (s.totalReasoningTokens && s.totalReasoningTokens > 0) {
      items.push({ kind: 'stat', label: 'Reasoning', value: `${formatTokens(s.totalReasoningTokens)} tokens` });
    }
    if (s.totalCachedTokens && s.totalCachedTokens > 0) {
      const hitRate = s.totalInputTokens > 0 ? Math.round((s.totalCachedTokens / s.totalInputTokens) * 100) : 0;
      items.push({ kind: 'stat', label: 'Cached', value: `${formatTokens(s.totalCachedTokens)} (${hitRate}% hit)` });
    }
    if (s.totalCacheWriteTokens && s.totalCacheWriteTokens > 0) {
      items.push({ kind: 'stat', label: 'Cache write', value: `${formatTokens(s.totalCacheWriteTokens)} tokens` });
    }
    if (s.errorCount > 0) {
      items.push({ kind: 'stat', label: 'Errors', value: String(s.errorCount) });
    }
    return items;
  }
}

export class QuickStatsTreeProvider implements vscode.TreeDataProvider<TreeItemData> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItemData | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** -1 = All Time; 0..N = index into availableMonths (0 = most recent). */
  private selectedMonthIdx = 0;
  private availableMonths: { year: number; month: number; label: string; start: number; end: number }[] = [];
  private activeProvider: ProviderId = 'copilot';

  constructor(private db: TrackerDatabase) {}

  setActiveProvider(provider: ProviderId): void {
    if (provider === this.activeProvider) { return; }
    this.activeProvider = provider;
    // A switch lands on the new provider's current month, never a stale historical
    // index that could point past its (different) availableMonths list (§15 #8).
    this.selectedMonthIdx = 0;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  navOlder(): void {
    if (this.selectedMonthIdx === -1) { return; }
    this.selectedMonthIdx = Math.min(this.selectedMonthIdx + 1, Math.max(0, this.availableMonths.length - 1));
    this.refresh();
  }

  navNewer(): void {
    if (this.selectedMonthIdx > 0) { this.selectedMonthIdx--; }
    else if (this.selectedMonthIdx === -1) { this.selectedMonthIdx = 0; }
    this.refresh();
  }

  navAllTime(): void {
    this.selectedMonthIdx = -1;
    this.refresh();
  }

  navCurrentMonth(): void {
    this.selectedMonthIdx = 0;
    this.refresh();
  }

  async showMonthPicker(): Promise<void> {
    const months = this.db.getAvailableMonths(this.activeProvider);
    type QPI = vscode.QuickPickItem & { idx: number };
    const qpItems: QPI[] = [
      ...months.map((m, i): QPI => ({
        label: m.label,
        description: i === 0 ? 'current billing period' : 'historical',
        iconPath: new vscode.ThemeIcon(i === 0 ? 'calendar' : 'history'),
        picked: this.selectedMonthIdx === i,
        idx: i,
      })),
      {
        label: 'All Time',
        description: 'cumulative totals across all months',
        iconPath: new vscode.ThemeIcon('list-flat'),
        picked: this.selectedMonthIdx === -1,
        idx: -1,
      },
    ];
    const picked = await vscode.window.showQuickPick(qpItems, {
      title: 'Select Billing Period',
      placeHolder: 'Choose a month to view stats for\u2026',
      matchOnDescription: true,
    }) as QPI | undefined;
    if (!picked) { return; }
    this.selectedMonthIdx = picked.idx;
    this.refresh();
  }

  getTreeItem(element: TreeItemData): vscode.TreeItem {
    switch (element.kind) {
      case 'providerHeader':
        return providerHeaderItem(element.provider);

      case 'section': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('dash');
        item.contextValue = 'quickStatsSection';
        return item;
      }
      case 'metric': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.value;
        item.iconPath = new vscode.ThemeIcon(element.icon);
        if (element.tooltip) {
          const md = new vscode.MarkdownString(element.tooltip);
          md.isTrusted = false;
          item.tooltip = md;
        }
        return item;
      }
      case 'picker': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.description;
        item.iconPath = new vscode.ThemeIcon('chevron-down');
        item.tooltip = new vscode.MarkdownString(element.tooltip);
        item.command = { command: 'copilotUsageTracker.stats.selectMonth', title: 'Select Period' };
        item.contextValue = 'quickStatsPicker';
        return item;
      }
      case 'tip': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('lightbulb');
        return item;
      }
      case 'action': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.command  = { command: element.command, title: element.label };
        item.iconPath = new vscode.ThemeIcon(element.icon ?? 'dashboard');
        return item;
      }
      default: {
        // 'stat' — kept for SessionTreeProvider children.
        const e = element as { label: string; value: string };
        const text = e.value ? `${e.label}: ${e.value}` : e.label;
        const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('pulse');
        return item;
      }
    }
  }

  getChildren(): TreeItemData[] {
    const config = getConfig();
    const isClaude = this.activeProvider === 'claude';
    this.availableMonths = this.db.getAvailableMonths(this.activeProvider);

    // Snap the selected index into range. If this provider has no months, or the
    // index points past its (provider-specific) list, fall back to the current
    // month (0) so wfBounds is never undefined (§15 #8).
    if (this.selectedMonthIdx >= 0 && this.selectedMonthIdx >= this.availableMonths.length) {
      this.selectedMonthIdx = 0;
    }

    const isAllTime     = this.selectedMonthIdx === -1;
    const isCurrentMonth = !isAllTime && this.selectedMonthIdx === 0;

    let periodOverride: { start: number; end: number } | undefined;
    if (isAllTime) {
      periodOverride = { start: 0, end: 253402300800000 };       // epoch 0 -> year 9999
    } else if (!isCurrentMonth && this.availableMonths.length > 0) {
      const m = this.availableMonths[this.selectedMonthIdx];
      periodOverride = { start: m.start, end: m.end };
    }

    // Resolve concrete period bounds (always a real range, never undefined).
    const liveBounds = getBillingPeriodBounds();
    const wfBounds = isAllTime
      ? { start: 0, end: 253402300800000 }
      : isCurrentMonth
        ? liveBounds
        : this.availableMonths[this.selectedMonthIdx];
    const daysRemaining = isCurrentMonth ? liveBounds.daysRemaining : 0;
    const wf = this.db.getWorkflowSummary(wfBounds.start, wfBounds.end, this.activeProvider);

    // Copilot billing is skipped entirely for Claude (§15 #5) — it relies on
    // GitHub AI-credit reads that are meaningless for Claude.
    const billing = isClaude ? undefined : computeBillingStatus(this.db, config.plan, Date.now(), periodOverride);

    const periodLabel = isAllTime
      ? 'All Time'
      : this.availableMonths.length > 0
        ? this.availableMonths[this.selectedMonthIdx].label
        : new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    const items: TreeItemData[] = [{ kind: 'providerHeader', provider: this.activeProvider }];

    // ?? Period picker (single row at top — click opens QuickPick) ?????????????
    const monthListMd = this.availableMonths.length === 0
      ? '_No data yet_'
      : this.availableMonths
          .map((m, i) => `- ${m.label}${i === 0 ? '  _(current)_' : ''}`)
          .join('\n') + '\n- All Time';
    const pickerPeriodHint = isAllTime
      ? 'all months combined'
      : isCurrentMonth
        ? `${daysRemaining}d remaining`
        : 'historical';
    const planLabel = isClaude ? 'CLAUDE' : `COPILOT ${config.plan.toUpperCase()}`;
    const pickerDesc = `${planLabel}  \u00b7  ${pickerPeriodHint}  \u00b7  click to change \u25be`;
    const pickerTooltip = `**Billing Period** \u2014 click to change\n\n${monthListMd}`;
    items.push({ kind: 'picker', label: periodLabel, description: pickerDesc, tooltip: pickerTooltip });

    // ?? BILLING section ???????????????????????????????????????????????????????

    if (billing) {
    // Activity (informational): how many sessions and chat requests in the period.
    const act = billing.activity;
    items.push({
      kind: 'metric', label: 'Activity',
      value: `${qFmt(act.sessions)} sessions  ·  ${qFmt(act.chatRequests)} chat requests`,
      icon: 'comment-discussion',
      tooltip: '**Sessions:** Copilot sessions with at least one chat request or model call in this period.\n\n**Chat requests:** prompts you sent (including failed ones; prompts the agent sends to subagents are not counted).',
    });

    const credUsed   = billing.new.aiCreditsUsed;
    const credQuota  = billing.new.aiCreditsQuota;
    const baseQuota  = billing.new.baseAiCreditsQuota;
    const promoBonus = billing.new.promoCreditsBonus;
    const promoUsed  = billing.new.promoCreditsUsed;
    // Actual free credits consumed — capped at the promo bonus size
    const promoFree  = Math.min(promoUsed, promoBonus);
    // Credits beyond the total (paid + promo) quota
    const overQuota  = credQuota !== null ? Math.max(0, credUsed - credQuota) : 0;
    const isPromo    = billing.new.quotaIsPromotional && promoBonus > 0 && baseQuota !== null;
    const measured   = billing.new.directCreditsMeasured;

    if (isCurrentMonth && credQuota !== null) {
      const pct = billing.new.percentUsed ?? 0;
      let credValue: string;

      if (overQuota > 0) {
        // Over total quota — progress bar is useless at >100%; show raw overage instead
        credValue = `${dFmt(credUsed)} / ${qFmt(credQuota)}  \u26a0 +${qFmt(Math.round(overQuota))} over${measured ? '  \u2713' : ''}`;
      } else if (isPromo && promoFree > 0) {
        // Inside promo zone but within total quota
        credValue = `${dFmt(credUsed)} / ${qFmt(credQuota)}  ${uBar(pct)} ${Math.round(pct)}%  (${qFmt(Math.round(promoFree))} free)${measured ? '  \u2713' : ''}`;
      } else {
        credValue = `${dFmt(credUsed)} / ${qFmt(credQuota)}  ${uBar(pct)} ${Math.round(pct)}%${measured ? '  \u2713' : ''}`;
      }

      // Tooltip: per-bucket breakdown, only shown when promo is active
      let credTooltip: string | undefined;
      if (isPromo) {
        const paidUsed = Math.min(credUsed, baseQuota!);
        const paidPct  = Math.min(100, Math.round((paidUsed  / baseQuota!) * 100));
        const promoPct = Math.min(100, Math.round((promoFree / promoBonus)  * 100));
        const promoUSD = `$${(promoBonus / 100).toFixed(2)}`;
        const lines: string[] = [
          `**AI Credits \u2014 ${periodLabel}**`,
          '',
          '**Paid** _(subscription included)_',
          `${dFmt(paidUsed)} / ${qFmt(baseQuota!)}  ${uBar(paidPct)} ${paidPct}%`,
          '',
          '**Promo** _(free until Sep 1, 2026)_',
          `${dFmt(promoFree)} / ${qFmt(promoBonus)}  ${uBar(promoPct)} ${promoPct}%  \u2192 ${promoUSD} free`,
        ];
        if (overQuota > 0) {
          lines.push('', `**\u26a0 Over quota by ${qFmt(Math.round(overQuota))} credits**`, '_Billed at $0.01 / credit above the total_');
        }
        lines.push('', `**Total used:** ${dFmt(credUsed)} credits = $${billing.new.estimatedCostUSD.toFixed(2)}`);
        lines.push(`**Promo saves:** ${promoUSD} free this month`);
        if (measured) { lines.push('', '_\u2713 Costs sourced directly from Copilot API_'); }
        credTooltip = lines.join('\n\n');
      } else if (measured) {
        credTooltip = '_\u2713 Costs sourced directly from Copilot API_';
      }

      items.push({ kind: 'metric', label: 'AI Credits', value: credValue, icon: 'credit-card', tooltip: credTooltip });
    } else if (isCurrentMonth) {
      items.push({ kind: 'metric', label: 'AI Credits', value: `${dFmt(credUsed)}${measured ? '  \u2713' : ''}  (no quota)`, icon: 'credit-card' });
    } else {
      items.push({ kind: 'metric', label: 'AI Credits', value: `${dFmt(credUsed)} total${measured ? '  \u2713' : ''}`, icon: 'credit-card' });
    }

    // Est. Cost — show the promo-free savings inline so the user sees what's "on them"
    const promoSavingsUSD = promoFree / 100;
    const costStr   = `$${billing.new.estimatedCostUSD.toFixed(2)} USD`;
    const promoNote = (isPromo && promoFree > 0)
      ? `  (\u2212$${promoSavingsUSD.toFixed(2)} promo free)`
      : '';
    const costTooltip = (isPromo && promoFree > 0)
      ? `**Estimated cost breakdown**\n\n` +
        `**Gross:** $${billing.new.estimatedCostUSD.toFixed(2)} ` +
        `(${dFmt(credUsed)} credits \u00d7 $0.01)\n\n` +
        `**Promo credit:** \u2212$${promoSavingsUSD.toFixed(2)} ` +
        `(${qFmt(promoBonus)} free credits)\n\n` +
        `**Net extra:** $${(billing.new.estimatedCostUSD - promoSavingsUSD).toFixed(2)} above subscription`
      : undefined;
    items.push({ kind: 'metric', label: 'Est. Cost', value: `${costStr}${promoNote}`, icon: 'symbol-numeric', tooltip: costTooltip });
    } else {
      // Claude: USD + token totals only — no credits / promo (§7).
      const cb = computeClaudeBilling(this.db, { start: wfBounds.start, end: wfBounds.end }, periodLabel, config.claudeCostBasis, !isCurrentMonth);
      const t = cb.tokenTotals;
      const costLabel = config.claudeCostBasis === 'subscription' ? 'Cost (API-equiv)' : 'Cost (USD)';
      items.push({ kind: 'metric', label: costLabel, value: `$${cb.costUSD.toFixed(2)}`, icon: 'symbol-numeric', tooltip: cb.notes.join('\n\n') });
      // "Fresh" input excludes the re-read cached prefix (shown on the Cache row below),
      // so this reads comparably to Claude Code's own usage panel. Cost uses inclusive input.
      const freshIn = Math.max(0, t.input - t.cachedInput - t.cacheWrite);
      items.push({ kind: 'metric', label: 'Tokens', value: `${qFmt(freshIn)} fresh in · ${qFmt(t.output)} out`, icon: 'symbol-numeric', tooltip: `${qFmt(t.input)} total input incl. cache read/write` });
      items.push({ kind: 'metric', label: 'Cache', value: `${qFmt(t.cachedInput)} read · ${qFmt(t.cacheWrite)} write`, icon: 'database' });
    }

    // ?? WORKFLOW section ??????????????????????????????????????????????????????
    if (wf.totalTurns > 0) {
      items.push({ kind: 'section', label: 'WORKFLOW' });
      items.push({ kind: 'metric', label: 'Efficiency', value: `${wf.avgTurnsPerMessage} turns/msg  \u00b7  ${wf.avgToolsPerTurn} tools/turn`, icon: 'pulse' });
      items.push({ kind: 'metric', label: 'Tool Calls', value: `${qFmt(wf.totalToolCalls)}  \u00b7  ${qFmt(wf.totalSubagents)} subagents`, icon: 'tools' });
      if (wf.totalErrors > 0) {
        const errPct = wf.totalToolCalls > 0 ? Math.round((wf.totalErrors / wf.totalToolCalls) * 100) : 0;
        items.push({ kind: 'metric', label: 'Errors', value: `${qFmt(wf.totalErrors)} (${errPct}% rate)`, icon: 'warning' });
      }
    }

    // ?? TIPS section ?????????????????????????????????????????????????????????
    if (isCurrentMonth && billing) {
      const tips: string[] = [];
      if (wf.avgTurnsPerMessage > 8) {
        tips.push('High turns/msg \u2014 be more specific to save tokens');
      }
      if (tips.length > 0) {
        items.push({ kind: 'section', label: 'TIPS' });
        for (const tip of tips.slice(0, 2)) {
          items.push({ kind: 'tip', label: tip });
        }
      }
    }

    // ?? Dashboard action ??????????????????????????????????????????????????????
    items.push({ kind: 'action', label: 'Open Dashboard', command: 'copilotUsageTracker.openDashboard', icon: 'dashboard' });
    return items;
  }
}

/**
 * The colored active-provider header row shown at the top of both trees.
 * Orange detail for Claude, Copilot blue for Copilot. Clicking it switches.
 */
function providerHeaderItem(provider: ProviderId): vscode.TreeItem {
  const isClaude = provider === 'claude';
  const item = new vscode.TreeItem(isClaude ? 'Claude Code' : 'GitHub Copilot', vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(isClaude ? 'charts.orange' : 'charts.blue'));
  item.description = 'click to switch ⇄';
  item.command = { command: 'copilotUsageTracker.toggleProvider', title: 'Switch Provider' };
  item.tooltip = new vscode.MarkdownString(`Active provider: **${isClaude ? 'Claude Code' : 'GitHub Copilot'}**\n\nClick to switch between GitHub Copilot and Claude Code.`);
  item.contextValue = 'providerHeader';
  return item;
}

/** Unicode block progress bar, 10 chars wide. */
function uBar(pct: number): string {
  const filled = Math.min(Math.round(pct / 10), 10);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
}

/** Format integer with thousands separators. */
function qFmt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Format decimal (1 dp) with thousands separators. */
function dFmt(n: number): string {
  return n.toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function shortModelName(model: string): string {
  if (model.startsWith('claude-')) {
    const parts = model.replace('claude-', '').split('-');
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  return model;
}
