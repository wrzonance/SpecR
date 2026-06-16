using System;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Refit;

namespace SpecRAddin
{
    /// <summary>Refit description of the subset of the SpecR REST API the add-in calls.</summary>
    /// <remarks>
    /// Matches <c>openapi.yaml</c> at the repository root. Extend this interface as
    /// later phases wire up parameter mappings (<c>PATCH /specs/{id}/paragraphs/{nodeId}</c>).
    /// </remarks>
    public interface ISpecRApi
    {
        [Get("/health")]
        Task<SpecRApiResponse<HealthStatus>> GetHealthAsync(CancellationToken cancellationToken = default);

        [Get("/specs/{id}")]
        Task<SpecRApiResponse<SpecTree>> GetSpecAsync(string id, CancellationToken cancellationToken = default);
    }

    /// <summary>Raised when SpecR returns a non-success envelope or the call fails.</summary>
    public sealed class SpecRClientException : Exception
    {
        public SpecRClientException(string message, Exception? innerException = null)
            : base(message, innerException)
        {
        }
    }

    /// <summary>
    /// Typed client for a running SpecR instance. Wraps the Refit interface, unwraps
    /// the <c>ApiResponse&lt;T&gt;</c> envelope, and surfaces failures as
    /// <see cref="SpecRClientException"/> with context.
    /// </summary>
    public sealed class SpecRClient : IDisposable
    {
        /// <summary>Environment variable that overrides the default base URL.</summary>
        public const string BaseUrlEnvVar = "SPECR_API_URL";

        /// <summary>Default SpecR dev server origin (see openapi.yaml <c>servers</c>).</summary>
        public const string DefaultBaseUrl = "http://localhost:3000";

        private readonly HttpClient _http;
        private readonly ISpecRApi _api;

        public SpecRClient(string? baseUrl = null)
        {
            var origin = string.IsNullOrWhiteSpace(baseUrl) ? ResolveBaseUrl() : baseUrl!;
            if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri))
            {
                throw new SpecRClientException($"invalid SpecR base URL: '{origin}'");
            }

            _http = new HttpClient
            {
                BaseAddress = uri,
                Timeout = TimeSpan.FromSeconds(30),
            };
            var settings = new RefitSettings(
                new SystemTextJsonContentSerializer(
                    new JsonSerializerOptions
                    {
                        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                        PropertyNameCaseInsensitive = true,
                    }));
            _api = RestService.For<ISpecRApi>(_http, settings);
        }

        /// <summary>Resolve the base URL from the environment, falling back to localhost.</summary>
        public static string ResolveBaseUrl()
        {
            var fromEnv = Environment.GetEnvironmentVariable(BaseUrlEnvVar);
            return string.IsNullOrWhiteSpace(fromEnv) ? DefaultBaseUrl : fromEnv!;
        }

        /// <summary>Liveness check against <c>GET /health</c>.</summary>
        public Task<HealthStatus> GetHealthAsync(CancellationToken cancellationToken = default)
        {
            return UnwrapAsync(_api.GetHealthAsync(cancellationToken), "GET /health");
        }

        /// <summary>Fetch a spec and its paragraph tree from <c>GET /specs/{id}</c>.</summary>
        public Task<SpecTree> GetSpecAsync(string specId, CancellationToken cancellationToken = default)
        {
            if (string.IsNullOrWhiteSpace(specId) || !Guid.TryParse(specId, out _))
            {
                throw new SpecRClientException($"spec id must be a UUID, got '{specId}'");
            }

            return UnwrapAsync(_api.GetSpecAsync(specId, cancellationToken), $"GET /specs/{specId}");
        }

        private static async Task<T> UnwrapAsync<T>(Task<SpecRApiResponse<T>> call, string context)
        {
            SpecRApiResponse<T> response;
            try
            {
                response = await call.ConfigureAwait(false);
            }
            catch (ApiException ex)
            {
                throw new SpecRClientException($"{context} failed: HTTP {(int)ex.StatusCode} {ex.ReasonPhrase}", ex);
            }
            catch (HttpRequestException ex)
            {
                throw new SpecRClientException($"{context} failed: cannot reach SpecR ({ex.Message})", ex);
            }

            if (!response.Success || response.Data is null)
            {
                throw new SpecRClientException($"{context} returned an error: {response.Error ?? "no data"}");
            }

            return response.Data;
        }

        public void Dispose()
        {
            _http.Dispose();
        }
    }
}
