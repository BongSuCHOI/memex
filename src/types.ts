export type EvidenceSourceType =
  | 'human_assertion'
  | 'assistant_generated'
  | 'repo_file'
  | 'git_history'
  | 'test_execution'
  | 'external_unverified'
  | 'memex_recall';

export interface ToolCall {
  id: string;
  exchangeId: string;
  toolName: string;
  toolInput?: any;
  toolResult?: string;
  isError: boolean;
  timestamp: string;
  sourceType?: EvidenceSourceType;
  learnable?: boolean;
}

export interface ConversationExchange {
  id: string;
  project: string;
  timestamp: string;
  userMessage: string;
  assistantMessage: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;

  // Conversation structure
  parentUuid?: string;
  isSidechain?: boolean;

  // Session context
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  codexVersion?: string;

  // Thinking metadata
  thinkingLevel?: string;
  thinkingDisabled?: boolean;
  thinkingTriggers?: string; // JSON array

  // Evidence provenance. Search keeps the full exchange, while fact extraction
  // may exclude agent text that was generated from recalled Memex context.
  provenance?: EvidenceSourceType[];
  assistantLearnable?: boolean;
  hasMemexRecall?: boolean;

  // Tool calls (populated separately)
  toolCalls?: ToolCall[];
}

export interface SearchResult {
  exchange: ConversationExchange;
  similarity: number;
  snippet: string;
}

export interface MultiConceptResult {
  exchange: ConversationExchange;
  snippet: string;
  conceptSimilarities: number[];
  averageSimilarity: number;
}

// === Fact Types ===

export type FactCategory = 'decision' | 'preference' | 'pattern' | 'knowledge' | 'constraint';
export type FactScopeType = 'global' | 'project';
export type FactRelation = 'DUPLICATE' | 'CONTRADICTION' | 'EVOLUTION' | 'INDEPENDENT';
export type FactGroundingType = 'explicit' | 'verified' | 'inferred';
export type FactContextDependencyKind =
  | 'assistant_context'
  | 'recall_influenced_assistant'
  | 'watermark_prefix'
  | 'conversation_context'
  | 'ratified_proposition'
  | 'referent_definition'
  | 'style_reference'
  | 'workflow_reference'
  | 'recall_reference';
export type FactEvidenceSource = 'human' | 'tool';
export type HumanEvidenceKind =
  | 'assertion'
  | 'decision'
  | 'correction'
  | 'ratification'
  | 'repeated_signal';
export type ToolEvidenceKind = 'repo_file' | 'git_history' | 'test_execution';

/** Model-declared evidence. The extractor validates every field against the
 * selected exchange rows before it resolves authoritative UUID lineage. */
export interface ExtractedFactEvidence {
  exchange_index: number;
  source: FactEvidenceSource;
  kind: HumanEvidenceKind | ToolEvidenceKind;
  /** Exact substring of the authoritative human message or tool result. */
  supporting_span: string;
  /** Exact DB tool_calls.id; required when source is tool. */
  tool_call_id?: string;
  tool_name?: string;
  source_type?: ToolEvidenceKind;
}

/** Model-declared by a server-provided context ID and server-resolved to a
 * UUID/kind after bounded causal checks. This non-authoritative local audit
 * lineage never substitutes for source_exchange_ids. */
export interface FactContextDependency {
  exchange_id: string;
  dependency_kind: FactContextDependencyKind;
}

export interface Fact {
  id: string;
  fact: string;
  category: FactCategory;
  scope_type: FactScopeType;
  scope_project: string | null;
  source_exchange_ids: string[];
  embedding: Float32Array | null;
  created_at: string;
  updated_at: string;
  consolidated_count: number;
  is_active: boolean;
  ontology_category_id?: string | null;
  /**
   * Local meaning-generation token: bumped by every semantic mutation
   * (fact-management.mutateFactMeaning, sync fact import). Async derived
   * writers capture it before their LLM/embedding work and CAS their final
   * write on it — a stale result is discarded, never merged into the newer
   * meaning. Rows predating the column start at 1.
   */
  semantic_generation?: number;
  /** Timestamp of the semantic event that produced the current meaning. */
  semantic_updated_at?: string | null;
  /**
   * Local activation-generation token (재감사 P1-4 v4): bumped by every
   * lifecycle transition (deactivate, restore, replicated lifecycle import).
   * Consolidation captures it together with semantic_generation — a
   * participant whose activation state moved during the comparison await
   * invalidates the verdict even though the meaning is unchanged. Rows
   * predating the column start at 1.
   */
  lifecycle_generation?: number;
  /** Timestamp of the lifecycle event that produced the current activation
   * state — replicated events keep their ORIGINAL remote event time. */
  lifecycle_updated_at?: string | null;
}

export interface FactRevision {
  id: string;
  fact_id: string;
  previous_fact: string;
  new_fact: string;
  reason: string | null;
  source_exchange_id: string | null;
  created_at: string;
}

export interface FactSearchResult {
  fact: Fact;
  similarity: number;
}

export interface ExtractedFact {
  fact: string;
  fact_kr?: string;
  category: FactCategory;
  scope_type: FactScopeType;
  confidence: number;
  /** Transient extraction diagnostics; not part of durable fact sync state. */
  grounding_type?: FactGroundingType;
  durable?: boolean;
  evidence?: ExtractedFactEvidence[];
  /** Model-declared, server-resolved local context lineage after causal checks. */
  context_dependencies?: FactContextDependency[];
  /** Server-resolved UUIDs; present on candidates accepted by the extractor. */
  source_exchange_ids?: string[];
}

export interface ConsolidationResult {
  relation: FactRelation;
  merged_fact: string;
  reason: string;
}

// === Ontology Types ===

export interface OntologyDomain {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface OntologyCategory {
  id: string;
  domain_id: string;
  name: string;
  description: string | null;
  created_at: string;
  embedding_version: number;
}

export type RelationType = 'INFLUENCES' | 'SUPERSEDES' | 'SUPPORTS' | 'CONTRADICTS';

export interface OntologyRelation {
  id: string;
  source_fact_id: string;
  relation_type: RelationType;
  target_fact_id: string;
  reasoning: string | null;
  created_at: string;
}

export interface AvatarResponse {
  answer: string;
  sources: Array<{
    fact: Fact;
    domain: string;
    category: string;
    relevance: number;
  }>;
  confidence: number;
  relatedDecisions: Array<{
    fact: Fact;
    relation: RelationType;
  }>;
}

export interface DomainTree {
  domain: OntologyDomain;
  categories: Array<{
    category: OntologyCategory;
    facts: Fact[];
  }>;
}
