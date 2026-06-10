Set objShell = WScript.CreateObject("WScript.Shell")
objShell.CurrentDirectory = "c:\Users\tatar\Projects\dev-flow"
objShell.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ""c:\Users\tatar\Projects\dev-flow\tray-server.ps1""", 0, False
