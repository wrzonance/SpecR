using System;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace SpecRAddin
{
    /// <summary>
    /// Ribbon command that exercises <see cref="SpecRClient"/> end to end against a
    /// running SpecR dev server. This is the manual acceptance check for Phase 4c:
    /// click the button, confirm a healthy response.
    /// </summary>
    [Transaction(TransactionMode.ReadOnly)]
    public sealed class HealthCheckCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            var baseUrl = SpecRClient.ResolveBaseUrl();
            try
            {
                using var client = new SpecRClient(baseUrl);

                // Revit commands run on the UI thread; block on the async call so the
                // result is in hand before the dialog shows. GetAwaiter().GetResult()
                // surfaces the original exception (no AggregateException wrapping).
                var health = client.GetHealthAsync().GetAwaiter().GetResult();

                TaskDialog.Show(
                    "SpecR",
                    $"Connected to {baseUrl}\n\nDatabase: {health.Db}\nUptime: {health.Uptime}s");
                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                message = $"Could not reach SpecR at {baseUrl}: {ex.Message}";
                return Result.Failed;
            }
        }
    }
}
