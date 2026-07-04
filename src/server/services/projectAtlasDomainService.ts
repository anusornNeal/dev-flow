import type {
  AtlasDomain,
  AtlasDomainGraphSummary,
  AtlasDomainOverrideMap,
  AtlasEdge,
  AtlasNode,
  ProjectAtlas,
} from '../../types.js';

interface DomainRule {
  id: string;
  name: string;
  test: (node: AtlasNode) => boolean;
}

const DOMAIN_RULES: DomainRule[] = [
  { id: 'domain:android-build-modules', name: 'Build / Modules / Flavors', test: (node) => isAndroidBuildNode(node) },
  { id: 'domain:android-bootstrap-platform', name: 'App Entry / Bootstrap / Platform', test: (node) => isAndroidBootstrapNode(node) },
  { id: 'domain:android-dependency-injection', name: 'Dependency Injection / App Services', test: (node) => isAndroidDiNode(node) },
  { id: 'domain:android-navigation', name: 'Navigation / Screen Flow', test: (node) => Boolean(node.metadata?.androidNavigation) || /(^|\/)res\/navigation\//i.test(node.path ?? node.label) },
  { id: 'domain:android-compose-framework', name: 'Presentation Base / Compose Framework', test: (node) => /(^|\/)compose\/(base|components)\//i.test(node.path ?? node.label) },
  { id: 'domain:android-data-network', name: 'Data / Network / Repositories / Models', test: (node) => (node.path ?? node.label).includes('/data/remote/') || (node.path ?? node.label).includes('/common/utils/gson/') },
  { id: 'domain:android-auth', name: 'Auth / Login / OTP / PIN / Password', test: (node) => /(^|\/)(compose\/ui\/login|compose\/ui\/otp|ui\/pin|ui\/verify_otp|ui\/forgot_pin|data\/repository\/(api_key|login|otp|pin)|data\/model\/(api_key|login|otp|pin|reset_password))\//i.test(node.path ?? node.label) },
  { id: 'domain:android-onboarding', name: 'Onboarding / Registration / Worker Profile', test: (node) => /(^|\/)(compose\/ui\/onboarding_menu|ui\/app_onboard_worker|ui\/onboard_worker|ui\/onboarding|data\/repository\/onboard_worker|data\/repository\/ocr|data\/model\/(onboard_worker|personal_info|worker_area|work_type|worker_address_info|worker_profile_image|bank_account|uploaddocument|term_and_cond|ocr))\//i.test(node.path ?? node.label) },
  { id: 'domain:android-jobs', name: 'Jobs / Work Orders / Contractor Flow', test: (node) => /(^|\/)(compose\/ui\/jobs|ui\/jobs|ui\/new_jobs|ui\/search_jobs|data\/repository\/jobs|data\/model\/(job|new_jobs|additional_quotation|sku_product|services|unit|work_instruction))\//i.test(node.path ?? node.label) },
  { id: 'domain:android-calendar', name: 'Calendar / Availability / Scheduling', test: (node) => /(^|\/)(ui\/my_calendar|compose\/ui\/calendar_picker|data\/repository\/calendar|data\/model\/my_calendar|library\/calendar)\//i.test(node.path ?? node.label) },
  { id: 'domain:android-payments-income', name: 'Payments / Income / Financial Documents', test: (node) => /(^|\/)(compose\/ui\/income|ui\/payment_detail|data\/repository\/(income|payment)|data\/model\/(income|payment|payment_detail))\//i.test(node.path ?? node.label) },
  { id: 'domain:android-profile-settings', name: 'Profile / Settings / Notifications / Privacy', test: (node) => /(^|\/)(ui\/(profile|profile_edit_info|settings|setting_notification|notification|privacy_and_policy|privacy_setting|vaccine|grade_detail|grading|profile_subteam|contact_us|change_language|training_course|re_new_reference_code)|compose\/ui\/subteam|data\/repository\/(user|notification|vaccine|worker_grade|locale|biometric|sub_team|contact_us|training_course|remote_config)|data\/model\/(user|notification|vaccine|my_grade|grade_detail|sub_team_profile|languages|worker|contact_us|training_course))\//i.test(node.path ?? node.label) },
  { id: 'domain:android-persistence', name: 'Persistence / Preferences / Local State', test: (node) => /(^|\/)(common\/utils\/(AppPreferences|SessionManager|RealmDatabase|InternalFileManager)|data\/repository\/(biometric|locale))|(^|\/)di\/(PrefsModules|DatabaseModules)\.kt$/i.test(node.path ?? node.label) },
  { id: 'domain:android-resources-ui', name: 'Resources / Design System / Legacy XML UI', test: (node) => isAndroidResourceNode(node) },
  { id: 'domain:local-libraries-native-stubby-automation', name: 'Local Libraries / Native / Stubby / Automation', test: (node) => /(^|\/)(library|nativelib|stubby|fastlane|localize_tools|scripts|docs)\//i.test(node.path ?? node.label) || Boolean(node.metadata?.stubby) },
  { id: 'domain:tests', name: 'Tests', test: (node) => node.kind === 'test' || /(^|\/)(tests?|__tests__)\//i.test(node.path ?? node.label) },
  { id: 'domain:ui-components', name: 'UI Components', test: (node) => node.kind === 'component' || /(^|\/)(components|viewModels|App\.tsx)/i.test(node.path ?? node.label) },
  { id: 'domain:task-management', name: 'Task Management', test: (node) => /(^|\/)(tasks?|taskService|taskRepository)/i.test(node.path ?? node.label) },
  { id: 'domain:agent-runs', name: 'Agent Runs', test: (node) => /(^|\/)(agent|agentRun|runner)/i.test(node.path ?? node.label) },
  { id: 'domain:mcp-tools', name: 'MCP Tools', test: (node) => /(^|\/)(mcp|contracts|devflowContract)/i.test(node.path ?? node.label) },
  { id: 'domain:prompt-system', name: 'Prompt System', test: (node) => /prompt|chatGptStarter/i.test(node.path ?? node.label) },
  { id: 'domain:skills', name: 'Skills', test: (node) => /(^|\/)skills?\//i.test(node.path ?? node.label) },
  { id: 'domain:project-workspace', name: 'Project/Workspace', test: (node) => /project|workspace/i.test(node.path ?? node.label) },
  { id: 'domain:database-persistence', name: 'Database/Persistence', test: (node) => node.kind === 'database' || /(^|\/)(db|database|migrations?|repositories?)\//i.test(node.path ?? node.label) },
  { id: 'domain:figma-integration', name: 'Figma Integration', test: (node) => /figma/i.test(node.path ?? node.label) },
  { id: 'domain:settings', name: 'Settings', test: (node) => /settings|config\/project-rules/i.test(node.path ?? node.label) },
];

const FALLBACK_DOMAIN = { id: 'domain:other', name: 'Other' };

export function suggestAtlasDomains(atlas: ProjectAtlas): ProjectAtlas {
  const domainMap = new Map<string, AtlasDomain>();
  const nodes = atlas.nodes.map((node) => {
    if (!isDomainAssignable(node)) return node;
    const domain = resolveDomainForNode(node);
    const nextNode = assignNodeToDomain(node, domain.id, 'inferred');
    upsertDomain(domainMap, domain.id, domain.name, nextNode.id, 'inferred');
    return nextNode;
  });
  const edges = withRelatedDomainEdges(atlas.edges, nodes);
  return { ...atlas, nodes, edges, domains: sortedDomains(domainMap) };
}

export function applyDomainOverrides(atlas: ProjectAtlas, overrides: AtlasDomainOverrideMap): ProjectAtlas {
  const overrideByNodeId = new Map<string, AtlasDomain>();
  const domainMap = new Map(atlas.domains.map((domain) => [domain.id, { ...domain, nodeIds: [...domain.nodeIds] }]));

  for (const override of overrides.domains) {
    const domain: AtlasDomain = {
      id: override.id,
      name: override.name,
      nodeIds: [...new Set(override.nodeIds)].sort(),
      origin: 'user-edited',
      metadata: { updatedAt: overrides.updatedAt },
    };
    domainMap.set(domain.id, domain);
    for (const nodeId of domain.nodeIds) {
      overrideByNodeId.set(nodeId, domain);
    }
  }

  const nodes = atlas.nodes.map((node) => {
    const override = overrideByNodeId.get(node.id);
    if (!override) return node;
    return {
      ...assignNodeToDomain(node, override.id, 'user-edited'),
      userEdited: {
        source: 'user-edited' as const,
        notes: `Assigned to domain '${override.name}'`,
        updatedAt: overrides.updatedAt,
      },
    };
  });

  const edges = withRelatedDomainEdges(atlas.edges.filter((edge) => !isDomainRelatedEdge(edge)), nodes);
  return { ...atlas, nodes, edges, domains: sortedDomains(domainMap) };
}

export function summarizeDomainGraph(atlas: ProjectAtlas): AtlasDomainGraphSummary {
  const nodeByDomain = new Map<string, AtlasNode[]>();
  for (const node of atlas.nodes) {
    const domainId = typeof node.metadata?.domainId === 'string' ? node.metadata.domainId : null;
    if (!domainId) continue;
    const nodes = nodeByDomain.get(domainId) ?? [];
    nodes.push(node);
    nodeByDomain.set(domainId, nodes);
  }
  return {
    domains: atlas.domains
      .map((domain) => {
        const nodes = nodeByDomain.get(domain.id) ?? [];
        return {
          id: domain.id,
          name: domain.name,
          origin: domain.origin,
          nodeCount: nodes.length,
          fileCount: nodes.filter((node) => Boolean(node.path)).length,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
    relatedEdges: atlas.edges.filter(isDomainRelatedEdge),
  };
}

function resolveDomainForNode(node: AtlasNode) {
  return DOMAIN_RULES.find((rule) => rule.test(node)) ?? FALLBACK_DOMAIN;
}

function isAndroidBuildNode(node: AtlasNode) {
  const target = node.path ?? node.label;
  return Boolean(node.metadata?.gradleConfig) ||
    /(^|\/)(settings|build)\.gradle(\.kts)?$/i.test(target) ||
    /(^|\/)(config|env|gradle)\.properties$/i.test(target) ||
    /(^|\/)google-services\.json$/i.test(target) ||
    /(^|\/)gradle\/libs\.versions\.toml$/i.test(target);
}

function isAndroidBootstrapNode(node: AtlasNode) {
  const target = node.path ?? node.label;
  return Boolean(node.metadata?.androidManifest) ||
    /(^|\/)Application\.kt$/i.test(target) ||
    /(^|\/)(ui\/splash_screen|ui\/main_screen|common\/deep_link|common\/utils\/notification|common\/exception)\//i.test(target);
}

function isAndroidDiNode(node: AtlasNode) {
  return /(^|\/)app\/src\/main\/java\/com\/qchang\/buddy\/di\/[^/]+\.kt$/i.test(node.path ?? node.label);
}

function isAndroidResourceNode(node: AtlasNode) {
  const target = node.path ?? node.label;
  return Boolean(node.metadata?.androidLayout || node.metadata?.androidValues) ||
    /(^|\/)app\/src\/main\/(res|assets)\//i.test(target);
}

function isDomainAssignable(node: AtlasNode) {
  return node.kind !== 'project' && node.kind !== 'folder' && node.kind !== 'domain';
}

function assignNodeToDomain(node: AtlasNode, domainId: string, origin: 'inferred' | 'user-edited'): AtlasNode {
  return {
    ...node,
    metadata: {
      ...(node.metadata ?? {}),
      domainId,
      domainOrigin: origin,
    },
  };
}

function upsertDomain(domainMap: Map<string, AtlasDomain>, id: string, name: string, nodeId: string, origin: 'inferred' | 'user-edited') {
  const existing = domainMap.get(id);
  if (existing) {
    if (!existing.nodeIds.includes(nodeId)) existing.nodeIds.push(nodeId);
    existing.nodeIds.sort();
    return;
  }
  domainMap.set(id, {
    id,
    name,
    nodeIds: [nodeId],
    origin,
    summary: `${name} files grouped from deterministic path heuristics.`,
  });
}

function withRelatedDomainEdges(edges: AtlasEdge[], nodes: AtlasNode[]) {
  const nodeDomains = new Map(nodes.map((node) => [node.id, typeof node.metadata?.domainId === 'string' ? node.metadata.domainId : null]));
  const nextEdges = edges.filter((edge) => !isDomainRelatedEdge(edge));
  const related = new Map<string, AtlasEdge>();
  for (const edge of nextEdges) {
    const sourceDomain = nodeDomains.get(edge.source);
    const targetDomain = nodeDomains.get(edge.target);
    if (!sourceDomain || !targetDomain || sourceDomain === targetDomain) continue;
    const id = `related:${sourceDomain}->${targetDomain}`;
    if (!related.has(id)) {
      related.set(id, {
        id,
        source: sourceDomain,
        target: targetDomain,
        kind: 'related',
        fact: {
          source: 'inferred',
          summary: `Cross-domain relationship inferred from ${edge.kind} edge.`,
        },
        metadata: { sourceEdgeKinds: [edge.kind] },
      });
      continue;
    }
    const kinds = related.get(id)?.metadata?.sourceEdgeKinds;
    if (Array.isArray(kinds) && !kinds.includes(edge.kind)) kinds.push(edge.kind);
  }
  return [...nextEdges, ...Array.from(related.values())].sort((left, right) => left.id.localeCompare(right.id));
}

function isDomainRelatedEdge(edge: AtlasEdge) {
  return edge.kind === 'related' && edge.source.startsWith('domain:') && edge.target.startsWith('domain:');
}

function sortedDomains(domainMap: Map<string, AtlasDomain>) {
  return Array.from(domainMap.values())
    .map((domain) => ({ ...domain, nodeIds: [...new Set(domain.nodeIds)].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
