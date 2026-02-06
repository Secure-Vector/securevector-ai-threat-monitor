; SecureVector AI Threat Monitor - Inno Setup Script
; Creates Windows installer (.exe)
; Usage: iscc /DAppSuffix=-dev securevector-setup.iss (for dev builds)

#ifndef AppSuffix
  #define AppSuffix ""
#endif

#define MyAppName "SecureVector" + AppSuffix
#define MyAppVersion GetEnv("APP_VERSION")
#if MyAppVersion == ""
  #define MyAppVersion "0.3.0"
#endif
#define MyAppPublisher "SecureVector"
#define MyAppURL "https://securevector.io"
#define MyAppExeName "SecureVector" + AppSuffix + ".exe"

[Setup]
AppId={{B8E7D5C4-9F2A-4B3E-8C1D-6A5F0E9B7D2C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=..\..\LICENSE
OutputDir=Output
OutputBaseFilename=SecureVector{#AppSuffix}-{#MyAppVersion}-Windows-Setup
SetupIconFile=..\..\src\securevector\app\assets\favicon.ico
UninstallDisplayIcon={app}\assets\favicon.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startupicon"; Description: "Start SecureVector when Windows starts"; GroupDescription: "Startup:"

[Files]
Source: "..\..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\src\securevector\rules\*"; DestDir: "{app}\rules"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\src\securevector\app\assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\favicon.ico"
Name: "{group}\{#MyAppName} (OpenClaw Proxy)"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\favicon.ico"; Parameters: "--web --proxy openclaw"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\favicon.ico"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\favicon.ico"; Parameters: "--minimized"; Tasks: startupicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Registry]
; Add to Windows Firewall exception
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#MyAppName}"; ValueData: """{app}\{#MyAppExeName}"" --minimized"; Flags: uninsdeletevalue; Tasks: startupicon

[Code]
// Custom code to handle service registration
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    // Create firewall rule for the API server
    Exec('netsh', 'advfirewall firewall add rule name="{#MyAppName}" dir=in action=allow program="' + ExpandConstant('{app}\{#MyAppExeName}') + '" enable=yes', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    // Remove firewall rule
    Exec('netsh', 'advfirewall firewall delete rule name="{#MyAppName}"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;
