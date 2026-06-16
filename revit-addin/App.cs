using System;
using System.Reflection;
using Autodesk.Revit.UI;

namespace SpecRAddin
{
    /// <summary>
    /// Revit external application entry point (Phase 4c scaffold). Registers a
    /// "SpecR" ribbon tab with a health-check button that proves connectivity to a
    /// running SpecR instance. No data flow yet — that arrives in later Phase 4 work.
    /// </summary>
    public sealed class App : IExternalApplication
    {
        private const string RibbonTab = "SpecR";
        private const string RibbonPanel = "Connection";

        public Result OnStartup(UIControlledApplication application)
        {
            try
            {
                application.CreateRibbonTab(RibbonTab);
                var panel = application.CreateRibbonPanel(RibbonTab, RibbonPanel);

                var assemblyPath = Assembly.GetExecutingAssembly().Location;
                var commandClass = typeof(HealthCheckCommand).FullName
                    ?? throw new InvalidOperationException("HealthCheckCommand type name unavailable");

                var buttonData = new PushButtonData(
                    name: "SpecRHealthCheck",
                    text: "Health\nCheck",
                    assemblyName: assemblyPath,
                    className: commandClass)
                {
                    ToolTip = "Ping the configured SpecR server (GET /health) and report status.",
                    LongDescription =
                        $"Calls SpecR at the URL in the {SpecRClient.BaseUrlEnvVar} environment " +
                        $"variable (default {SpecRClient.DefaultBaseUrl}).",
                };

                panel.AddItem(buttonData);
                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                TaskDialog.Show("SpecR", $"Failed to initialize the SpecR add-in:\n{ex.Message}");
                return Result.Failed;
            }
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            return Result.Succeeded;
        }
    }
}
