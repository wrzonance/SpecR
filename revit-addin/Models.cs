using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace SpecRAddin
{
    /// <summary>
    /// SpecR's standard response envelope (<c>ApiResponse&lt;T&gt;</c> in the
    /// OpenAPI contract). Named with a <c>SpecR</c> prefix to avoid clashing with
    /// Refit's own <c>ApiResponse&lt;T&gt;</c> transport wrapper.
    /// </summary>
    public sealed class SpecRApiResponse<T>
    {
        [JsonPropertyName("success")]
        public bool Success { get; set; }

        [JsonPropertyName("data")]
        public T? Data { get; set; }

        [JsonPropertyName("error")]
        public string? Error { get; set; }
    }

    /// <summary>Payload of <c>GET /health</c>.</summary>
    public sealed class HealthStatus
    {
        /// <summary>Database connectivity state — "connected" when healthy.</summary>
        [JsonPropertyName("db")]
        public string Db { get; set; } = string.Empty;

        /// <summary>Process uptime in whole seconds.</summary>
        [JsonPropertyName("uptime")]
        public long Uptime { get; set; }
    }

    /// <summary>Payload of <c>GET /specs/{id}</c> — a spec with its paragraph tree.</summary>
    public sealed class SpecTree
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        /// <summary>CSI section number (e.g. "09 91 26"), or "unknown".</summary>
        [JsonPropertyName("section")]
        public string Section { get; set; } = string.Empty;

        [JsonPropertyName("title")]
        public string Title { get; set; } = string.Empty;

        [JsonPropertyName("parts")]
        public List<SpecNode> Parts { get; set; } = new List<SpecNode>();
    }

    /// <summary>One node in the canonical CSI AST paragraph tree.</summary>
    public sealed class SpecNode
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        /// <summary>spec | part | article | pr1..pr5 | note | continuation.</summary>
        [JsonPropertyName("type")]
        public string Type { get; set; } = string.Empty;

        [JsonPropertyName("text")]
        public string Text { get; set; } = string.Empty;

        [JsonPropertyName("children")]
        public List<SpecNode> Children { get; set; } = new List<SpecNode>();

        [JsonPropertyName("meta")]
        public SpecNodeMeta? Meta { get; set; }
    }

    /// <summary>Per-node metadata. Revit-relevant fields surface here in Phase 4.</summary>
    public sealed class SpecNodeMeta
    {
        [JsonPropertyName("vanish")]
        public bool? Vanish { get; set; }

        [JsonPropertyName("source")]
        public string? Source { get; set; }

        /// <summary>Revit parameter binding for this paragraph (Phase 4).</summary>
        [JsonPropertyName("revitParam")]
        public string? RevitParam { get; set; }

        [JsonPropertyName("baseVersion")]
        public int? BaseVersion { get; set; }
    }
}
