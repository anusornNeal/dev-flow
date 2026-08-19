import type {
  UiPreviewDesignContext,
  UiPreviewDesignGateCategory,
  UiPreviewDesignGateEvidenceRef,
  UiPreviewDesignGateExceptionRef,
  UiPreviewDesignGateExceptionResult,
  UiPreviewDesignGateFinding,
  UiPreviewDesignGateResult,
  UiPreviewDesignGateSeverity,
  UiPreviewScreen,
} from '../domain/uiPreview.js';
import { UiPreviewError } from '../domain/uiPreview.js';
import { normalizeUiPreviewDesignGateExceptionRefs } from './uiSpecValidator.js';

export const UI_PREVIEW_DESIGN_GATE_POLICY_VERSION = 'ui-preview-design-gate.v1';

export const UI_PREVIEW_DESIGN_RULES = Object.freeze([
  { id: 'project.explicit-color', category: 'project-style', severity: 'warning' },
  { id: 'project.explicit-font-family', category: 'project-style', severity: 'warning' },
  { id: 'accessibility.image-alt', category: 'accessibility', severity: 'error' },
  { id: 'interaction.non-native-click-keyboard', category: 'interaction', severity: 'warning' },
  { id: 'destructive.confirmation-unproven', category: 'destructive-safety', severity: 'warning' },
  { id: 'aesthetic.unverified-gradient', category: 'aesthetic-heuristic', severity: 'warning' },
] as const);

const MAX_EVIDENCE_REFS = 8;
const MAX_REF_LENGTH = 280;
const GENERIC_FONT_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'inherit', 'initial', 'unset',
]);

type GateRule = (typeof UI_PREVIEW_DESIGN_RULES)[number];

export interface UiPreviewDesignGateInput {
  screens: UiPreviewScreen[];
  designContext: UiPreviewDesignContext;
  gatePolicyVersion: string;
  exceptionRefs?: unknown;
}

function boundedRef(value: string) {
  const compact = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  return compact.length <= MAX_REF_LENGTH ? compact : `${compact.slice(0, MAX_REF_LENGTH - 1)}…`;
}

function sourceEvidence(screenId: string, ref: string): UiPreviewDesignGateEvidenceRef {
  return { kind: 'source', screenId, ref: boundedRef(ref) };
}

function designContextEvidence(context: UiPreviewDesignContext) {
  return context.sources.slice(0, 2).map((source): UiPreviewDesignGateEvidenceRef => ({
    kind: 'design-context',
    ref: boundedRef(`${source.path}${source.startLine ? `:${source.startLine}${source.endLine ? `-${source.endLine}` : ''}` : ''}`),
  }));
}

function finding(rule: GateRule, severity: UiPreviewDesignGateSeverity, reasonCode: string, evidence: UiPreviewDesignGateEvidenceRef[]): UiPreviewDesignGateFinding {
  return {
    ruleId: rule.id,
    category: rule.category,
    severity,
    reasonCode,
    evidence: evidence.slice(0, MAX_EVIDENCE_REFS),
  };
}

function normalizeHex(value: string) {
  const input = value.toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(input)) return `#${[...input.slice(1)].map((part) => `${part}${part}`).join('')}`;
  if (/^#[0-9a-f]{4}$/.test(input)) return `#${[...input.slice(1)].map((part) => `${part}${part}`).join('')}`;
  return input;
}

function explicitHexColors(css: string) {
  return [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => normalizeHex(match[0])))];
}

function explicitFontFamilies(css: string) {
  const values: string[] = [];
  for (const match of css.matchAll(/font-family\s*:\s*([^;}\n]+)/gi)) {
    const first = match[1].split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (!first || /^var\(/i.test(first) || GENERIC_FONT_FAMILIES.has(first.toLowerCase())) continue;
    values.push(first);
  }
  return [...new Set(values)];
}

function projectSeverity(context: UiPreviewDesignContext, enforcementReasonCode: string): UiPreviewDesignGateSeverity {
  return context.sufficiency === 'sufficient' && context.reasonCodes.includes(enforcementReasonCode) ? 'error' : 'warning';
}

function projectReason(base: string, severity: UiPreviewDesignGateSeverity) {
  return severity === 'error' ? `${base}_CLOSED_SET_VIOLATION` : `${base}_CONTEXT_MISMATCH_UNPROVEN`;
}

function evaluateProjectColors(screens: UiPreviewScreen[], context: UiPreviewDesignContext) {
  const rule = UI_PREVIEW_DESIGN_RULES[0];
  const allowed = new Set(context.visual.colors.filter((value) => /^#[0-9a-fA-F]{3,8}$/.test(value)).map(normalizeHex));
  if (allowed.size === 0) return [] as UiPreviewDesignGateFinding[];
  const severity = projectSeverity(context, 'PROJECT_COLOR_SET_ENFORCED');
  const findings: UiPreviewDesignGateFinding[] = [];
  for (const screen of screens) {
    const outside = explicitHexColors(screen.css).filter((color) => !allowed.has(color));
    if (outside.length === 0) continue;
    findings.push(finding(rule, severity, projectReason('PROJECT_COLOR', severity), [
      ...outside.slice(0, 4).map((color, index) => sourceEvidence(screen.screenId, `css:explicit-color:${index + 1}:${color}`)),
      ...designContextEvidence(context),
    ]));
  }
  return findings;
}

function evaluateProjectFonts(screens: UiPreviewScreen[], context: UiPreviewDesignContext) {
  const rule = UI_PREVIEW_DESIGN_RULES[1];
  const allowed = new Set(context.visual.fontFamilies.map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) return [] as UiPreviewDesignGateFinding[];
  const severity = projectSeverity(context, 'PROJECT_FONT_SET_ENFORCED');
  const findings: UiPreviewDesignGateFinding[] = [];
  for (const screen of screens) {
    const outside = explicitFontFamilies(screen.css).filter((family) => !allowed.has(family.toLowerCase()));
    if (outside.length === 0) continue;
    findings.push(finding(rule, severity, projectReason('PROJECT_FONT', severity), [
      ...outside.slice(0, 4).map((_family, index) => sourceEvidence(screen.screenId, `css:explicit-font-family:${index + 1}`)),
      ...designContextEvidence(context),
    ]));
  }
  return findings;
}

function evaluateImageAlt(screens: UiPreviewScreen[]) {
  const rule = UI_PREVIEW_DESIGN_RULES[2];
  const findings: UiPreviewDesignGateFinding[] = [];
  for (const screen of screens) {
    const tags = [...screen.html.matchAll(/<img\b[^>]*>/gi)];
    const missing = tags.filter((match) => !/\balt\s*=/i.test(match[0]));
    if (missing.length === 0) continue;
    findings.push(finding(rule, 'error', 'IMAGE_ALT_MISSING', missing.slice(0, 8).map((_entry, index) => sourceEvidence(screen.screenId, `html:img:missing-alt:${index + 1}`))));
  }
  return findings;
}

function evaluateNonNativeKeyboard(screens: UiPreviewScreen[]) {
  const rule = UI_PREVIEW_DESIGN_RULES[3];
  const findings: UiPreviewDesignGateFinding[] = [];
  for (const screen of screens) {
    const tags = [...screen.html.matchAll(/<(div|span|li|section|article)\b([^>]*)>/gi)];
    const suspicious = tags.filter((match) => {
      const attrs = match[2];
      const clickable = /\bon(?:click|pointerup)\s*=/i.test(attrs);
      const hasKeyboard = /\bon(?:keydown|keyup|keypress)\s*=|\btabindex\s*=|\brole\s*=\s*['"](?:button|link)['"]/i.test(attrs);
      return clickable && !hasKeyboard;
    });
    if (suspicious.length === 0) continue;
    findings.push(finding(rule, 'warning', 'NON_NATIVE_CLICK_KEYBOARD_UNPROVEN', suspicious.slice(0, 8).map((_entry, index) => sourceEvidence(screen.screenId, `html:non-native-click:${index + 1}`))));
  }
  return findings;
}

function evaluateDestructiveConfirmation(screens: UiPreviewScreen[], context: UiPreviewDesignContext) {
  const rule = UI_PREVIEW_DESIGN_RULES[4];
  if (!context.ux.ruleIds.includes('destructive-action-confirmation')) return [] as UiPreviewDesignGateFinding[];
  const findings: UiPreviewDesignGateFinding[] = [];
  for (const screen of screens) {
    const source = `${screen.html}\n${screen.js}`;
    if (!/\b(?:delete|remove|destroy|destructive)\b/i.test(source)) continue;
    if (/\bconfirm\s*\(|role\s*=\s*['"]dialog['"]|data-confirm|confirmdialog|\bmodal\b/i.test(source)) continue;
    findings.push(finding(rule, 'warning', 'DESTRUCTIVE_CONFIRMATION_UNPROVEN', [sourceEvidence(screen.screenId, 'source:destructive-action-without-provable-confirmation')]));
  }
  return findings;
}

function evaluateGradient(screens: UiPreviewScreen[]) {
  const rule = UI_PREVIEW_DESIGN_RULES[5];
  const findings: UiPreviewDesignGateFinding[] = [];
  for (const screen of screens) {
    if (!/(?:linear|radial|conic)-gradient\s*\(/i.test(screen.css)) continue;
    findings.push(finding(rule, 'warning', 'GRADIENT_PROJECT_BASIS_UNVERIFIED', [sourceEvidence(screen.screenId, 'css:gradient') ]));
  }
  return findings;
}

function validatePolicy(input: UiPreviewDesignGateInput) {
  if (input.gatePolicyVersion !== UI_PREVIEW_DESIGN_GATE_POLICY_VERSION || input.designContext.gatePolicyVersion !== UI_PREVIEW_DESIGN_GATE_POLICY_VERSION) {
    throw new UiPreviewError(
      'UI_PREVIEW_DESIGN_GATE_POLICY_MISMATCH',
      `UI preview design gate requires policy '${UI_PREVIEW_DESIGN_GATE_POLICY_VERSION}'.`,
    );
  }
  if (!Array.isArray(input.screens) || input.screens.length === 0) {
    throw new UiPreviewError('UI_PREVIEW_DESIGN_GATE_SOURCE_INVALID', 'Canonical UI preview screens are required for design-gate evaluation.');
  }
}

function rejectException(exceptionId: string, reasonCode: string): UiPreviewDesignGateExceptionResult {
  return { exceptionId, status: 'rejected', reasonCode, suppressedRuleIds: [] };
}

function isAuthorityRelated(exception: UiPreviewDesignGateExceptionRef, context: UiPreviewDesignContext) {
  const authority = exception.authority!;
  return Boolean(context.taskId) && authority.taskId === context.taskId && authority.projectId === context.projectId;
}

function authorityAllows(exception: UiPreviewDesignGateExceptionRef) {
  const authority = exception.authority!;
  return exception.ruleIds.every((ruleId) => authority.authorizedRuleIds.includes(ruleId))
    && exception.categories.every((category) => authority.authorizedCategories.includes(category));
}

function findingMatchesException(findingValue: UiPreviewDesignGateFinding, exception: UiPreviewDesignGateExceptionRef) {
  return exception.ruleIds.includes(findingValue.ruleId) || exception.categories.includes(findingValue.category);
}

function applyExceptions(findings: UiPreviewDesignGateFinding[], rawExceptionRefs: unknown, context: UiPreviewDesignContext) {
  const exceptions = normalizeUiPreviewDesignGateExceptionRefs(rawExceptionRefs);
  const remaining = [...findings];
  const suppressed: UiPreviewDesignGateFinding[] = [];
  const results: UiPreviewDesignGateExceptionResult[] = [];

  for (const exception of exceptions) {
    if (exception.ruleIds.length === 0 && exception.categories.length === 0) {
      results.push(rejectException(exception.exceptionId, 'EXCEPTION_TARGET_MISSING'));
      continue;
    }
    if (!exception.authority) {
      results.push(rejectException(exception.exceptionId, 'EXCEPTION_AUTHORITY_MISSING'));
      continue;
    }
    if (!exception.authority.current) {
      results.push(rejectException(exception.exceptionId, 'EXCEPTION_AUTHORITY_STALE'));
      continue;
    }
    if (!isAuthorityRelated(exception, context)) {
      results.push(rejectException(exception.exceptionId, 'EXCEPTION_AUTHORITY_UNRELATED'));
      continue;
    }
    if (exception.authority.type === 'frozen-ui-design' && (!exception.authority.evidenceId || !Number.isInteger(exception.authority.frozenRevision) || Number(exception.authority.frozenRevision) < 1)) {
      results.push(rejectException(exception.exceptionId, 'EXCEPTION_AUTHORITY_INVALID'));
      continue;
    }
    if (!authorityAllows(exception)) {
      results.push(rejectException(exception.exceptionId, 'EXCEPTION_TARGET_UNAUTHORIZED'));
      continue;
    }

    const matchedIndexes: number[] = [];
    for (let index = 0; index < remaining.length; index += 1) {
      if (findingMatchesException(remaining[index], exception)) matchedIndexes.push(index);
    }
    if (matchedIndexes.length === 0) {
      results.push(rejectException(exception.exceptionId, 'EXCEPTION_NO_CONFLICTING_FINDING'));
      continue;
    }

    const matched = matchedIndexes.map((index) => remaining[index]);
    for (const index of [...matchedIndexes].reverse()) remaining.splice(index, 1);
    suppressed.push(...matched);
    results.push({
      exceptionId: exception.exceptionId,
      status: 'applied',
      reasonCode: 'EXCEPTION_APPLIED',
      suppressedRuleIds: [...new Set(matched.map((entry) => entry.ruleId))],
    });
  }

  return { findings: remaining, suppressedFindings: suppressed, exceptionResults: results };
}

export function evaluateUiPreviewDesignGate(input: UiPreviewDesignGateInput): UiPreviewDesignGateResult {
  validatePolicy(input);
  const initialFindings = [
    ...evaluateProjectColors(input.screens, input.designContext),
    ...evaluateProjectFonts(input.screens, input.designContext),
    ...evaluateImageAlt(input.screens),
    ...evaluateNonNativeKeyboard(input.screens),
    ...evaluateDestructiveConfirmation(input.screens, input.designContext),
    ...evaluateGradient(input.screens),
  ];
  const exceptionResult = applyExceptions(initialFindings, input.exceptionRefs, input.designContext);
  return {
    gatePolicyVersion: UI_PREVIEW_DESIGN_GATE_POLICY_VERSION,
    blocked: exceptionResult.findings.some((entry) => entry.severity === 'error'),
    findings: exceptionResult.findings,
    suppressedFindings: exceptionResult.suppressedFindings,
    exceptionResults: exceptionResult.exceptionResults,
  };
}
