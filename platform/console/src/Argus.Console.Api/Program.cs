using Microsoft.AspNetCore.Authentication.JwtBearer;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddEnvironmentVariables();

string Require(string key) =>
    builder.Configuration[key] ?? throw new InvalidOperationException($"{key} is required, refusing to boot.");

var adfsAuthority = Require("Auth:Authority");
var gitopsRepo    = Require("GitOps:RepoUrl");
var openBaoAddr   = Require("OpenBao:Address");

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o => { o.Authority = adfsAuthority; o.Audience = "argus-console"; });
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("viewer",   p => p.RequireRole("Argus-Console-Viewers", "Argus-Console-Operators", "Argus-Console-Approvers", "Argus-Console-Security", "Argus-Console-Admins"))
    .AddPolicy("operator", p => p.RequireRole("Argus-Console-Operators", "Argus-Console-Admins"))
    .AddPolicy("approver", p => p.RequireRole("Argus-Console-Approvers", "Argus-Console-Admins"))
    .AddPolicy("security", p => p.RequireRole("Argus-Console-Security", "Argus-Console-Admins"))
    .AddPolicy("admin",    p => p.RequireRole("Argus-Console-Admins"));

builder.Services.AddProblemDetails();
builder.Services.AddOpenApi();

var app = builder.Build();
app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();

var v1 = app.MapGroup("/api/v1");
v1.MapGet("/health", () => Results.Ok(new { status = "healthy", version = typeof(Program).Assembly.GetName().Version?.ToString() }));

app.Logger.LogInformation("Argus Console API booted ({Env})", app.Environment.EnvironmentName);
app.Logger.LogInformation("Integration AD FS: {A}", adfsAuthority);
app.Logger.LogInformation("Integration GitOps: {R}", gitopsRepo);
app.Logger.LogInformation("Integration OpenBao: {O}", openBaoAddr);
app.Run();
