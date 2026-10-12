/** Static native adapter. Tool arguments arrive only as JSON on stdin, never as PowerShell code. */
export const COMPUTER_USE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WorkbenchDesktop {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk,wScan; public uint dwFlags,time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  public class Window { public string id; public string title; public uint processId; public int x,y,width,height; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc,IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd,StringBuilder text,int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd,out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle,int mode);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code,uint mode);
  public static List<Window> Windows() {
    var result=new List<Window>();
    EnumWindows(delegate(IntPtr h,IntPtr unused) {
      if(!IsWindowVisible(h)) return true;
      var title=new StringBuilder(1024); GetWindowText(h,title,title.Capacity);
      RECT r; if(title.Length==0 || !GetWindowRect(h,out r) || r.Right<=r.Left || r.Bottom<=r.Top) return true;
      uint pid; GetWindowThreadProcessId(h,out pid);
      result.Add(new Window { id=h.ToInt64().ToString(), title=title.ToString(), processId=pid, x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top });
      return true;
    },IntPtr.Zero); return result;
  }
  public static void Focus(IntPtr h) {
    if(!IsWindow(h)) throw new Exception("Window no longer exists");
    if(GetForegroundWindow()==h) return;
    ShowWindow(h,9);
    uint unused; uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out unused); uint current=GetCurrentThreadId();
    bool attached=foreground!=0 && foreground!=current && AttachThreadInput(current,foreground,true);
    try { BringWindowToTop(h); SetForegroundWindow(h); } finally { if(attached) AttachThreadInput(current,foreground,false); }
    if(GetForegroundWindow()!=h) throw new Exception("Windows denied focusing this window");
  }
  static INPUT Mouse(uint flags,int x,int y,uint data) { var i=new INPUT(); i.type=0; i.data.mouse=new MOUSEINPUT{dx=x,dy=y,dwFlags=flags,mouseData=data}; return i; }
  static INPUT Key(ushort vk,ushort scan,uint flags) {
    if(vk!=0) { scan=(ushort)MapVirtualKey(vk,0); if(scan==0)throw new Exception("Unsupported hardware key"); flags|=8; if((vk>=0x21&&vk<=0x2E)||vk==0x5B)flags|=1; vk=0; }
    var i=new INPUT(); i.type=1; i.data.key=new KEYBDINPUT{wVk=vk,wScan=scan,dwFlags=flags}; return i;
  }
  static void Send(List<INPUT> inputs) { if(inputs.Count==0)return; var a=inputs.ToArray(); if(SendInput((uint)a.Length,a,Marshal.SizeOf(typeof(INPUT)))!=a.Length) throw new Exception("Windows denied input injection; target may have higher privileges"); }
  public static void Move(int x,int y) { if(!SetCursorPos(x,y))throw new Exception("Windows denied pointer movement"); }
  public static void Click(int x,int y,string button,bool twice) {
    Move(x,y); uint down=2,up=4; if(button=="right"){down=8;up=16;} if(button=="middle"){down=32;up=64;}
    var items=new List<INPUT>(); for(int n=0;n<(twice?2:1);n++){items.Add(Mouse(down,0,0,0));items.Add(Mouse(up,0,0,0));} Send(items);
  }
  public static void Scroll(int amount) { var items=new List<INPUT>(); items.Add(Mouse(0x800,0,0,unchecked((uint)(amount*120)))); Send(items); }
  public static void TypeText(string text) { var items=new List<INPUT>(); foreach(char c in text){items.Add(Key(0,c,4));items.Add(Key(0,c,6));} Send(items); }
  static ushort Code(string key) {
    switch(key) { case "CTRL":case "CONTROL":return 0x11; case "SHIFT":return 0x10; case "ALT":return 0x12; case "WIN":return 0x5B;
      case "ENTER":return 0x0D;case "TAB":return 0x09;case "ESC":case "ESCAPE":return 0x1B;case "SPACE":return 0x20;case "BACKSPACE":return 0x08;
      case "DELETE":return 0x2E;case "INSERT":return 0x2D;case "HOME":return 0x24;case "END":return 0x23;case "PAGEUP":return 0x21;case "PAGEDOWN":return 0x22;
      case "LEFT":return 0x25;case "UP":return 0x26;case "RIGHT":return 0x27;case "DOWN":return 0x28; }
    if(key.Length==1 && ((key[0]>='A'&&key[0]<='Z') || (key[0]>='0'&&key[0]<='9'))) return (ushort)key[0];
    int fn; if(key.StartsWith("F")&&int.TryParse(key.Substring(1),out fn)&&fn>=1&&fn<=24)return (ushort)(0x70+fn-1);
    throw new Exception("Unsupported key: "+key);
  }
  public static void Press(string chord) {
    var parts=chord.ToUpperInvariant().Split('+'); var keys=new List<ushort>();
    for(int n=0;n<parts.Length;n++){var p=parts[n].Trim();if(n<parts.Length-1 && p!="CTRL"&&p!="CONTROL"&&p!="ALT"&&p!="SHIFT"&&p!="WIN")throw new Exception("Only modifiers may precede the final key");ushort code=Code(p);if(keys.Contains(code))throw new Exception("Duplicate key");keys.Add(code);}
    var items=new List<INPUT>(); foreach(var key in keys)items.Add(Key(key,0,0)); for(int n=keys.Count-1;n>=0;n--)items.Add(Key(keys[n],0,2)); Send(items);
  }
  public static void Drag(int x,int y,int toX,int toY,int left,int top,int width,int height) {
    var items=new List<INPUT>();
    items.Add(Mouse(0xC001,(int)((long)(x-left)*65535/Math.Max(1,width-1)),(int)((long)(y-top)*65535/Math.Max(1,height-1)),0));items.Add(Mouse(2,0,0,0));
    for(int n=1;n<=10;n++){int px=x+(toX-x)*n/10,py=y+(toY-y)*n/10;items.Add(Mouse(0xC001,(int)((long)(px-left)*65535/Math.Max(1,width-1)),(int)((long)(py-top)*65535/Math.Max(1,height-1)),0));}
    items.Add(Mouse(4,0,0,0));Send(items);
    // SendInput queues events; wait for the physical cursor before taking the result screenshot.
    POINT point;
    for(int n=0;n<50;n++) { if(GetCursorPos(out point)&&Math.Abs(point.X-toX)<=1&&Math.Abs(point.Y-toY)<=1)return;System.Threading.Thread.Sleep(10); }
    throw new Exception("Drag destination was not reached");
  }
}
'@
if ([WorkbenchDesktop]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { throw '无法启用物理像素坐标' }
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$region = $bounds
$window = [IntPtr]::Zero
if ($inputData.windowId) {
  $window = [IntPtr]([long]::Parse($inputData.windowId))
  if (-not [WorkbenchDesktop]::IsWindow($window)) { throw '所选窗口已关闭' }
  [WorkbenchDesktop]::Focus($window)
  $rect = New-Object WorkbenchDesktop+RECT
  if (-not [WorkbenchDesktop]::GetWindowRect($window,[ref]$rect)) { throw '无法读取窗口范围' }
  $region = [System.Drawing.Rectangle]::FromLTRB($rect.Left,$rect.Top,$rect.Right,$rect.Bottom)
  $region = [System.Drawing.Rectangle]::Intersect($region,$bounds)
}
function RequirePoint([int]$x,[int]$y) { if(-not $bounds.Contains($x,$y) -or (-not $region.Contains($x,$y))) { throw '坐标超出屏幕或所选窗口范围；请使用截图返回的全局坐标' } }
switch ($inputData.action) {
  'click' { RequirePoint $inputData.x $inputData.y; [WorkbenchDesktop]::Click($inputData.x,$inputData.y,$inputData.button,[bool]$inputData.double) }
  'move' { RequirePoint $inputData.x $inputData.y; [WorkbenchDesktop]::Move($inputData.x,$inputData.y) }
  'drag' { RequirePoint $inputData.x $inputData.y; RequirePoint $inputData.toX $inputData.toY; [WorkbenchDesktop]::Drag($inputData.x,$inputData.y,$inputData.toX,$inputData.toY,$bounds.X,$bounds.Y,$bounds.Width,$bounds.Height) }
  'scroll' { [WorkbenchDesktop]::Scroll($inputData.amount) }
  'type' { [WorkbenchDesktop]::TypeText($inputData.text) }
  'keypress' { [WorkbenchDesktop]::Press($inputData.key) }
  'wait' { Start-Sleep -Milliseconds $inputData.milliseconds }
}
$point=New-Object WorkbenchDesktop+POINT
[WorkbenchDesktop]::GetCursorPos([ref]$point) | Out-Null
$result=@{ action=$inputData.action; screen=@{x=$bounds.X;y=$bounds.Y;width=$bounds.Width;height=$bounds.Height}; cursor=@{x=$point.X;y=$point.Y}; foregroundWindowId=[WorkbenchDesktop]::GetForegroundWindow().ToInt64().ToString() }
if($inputData.action -eq 'windows') { $result.windows=@([WorkbenchDesktop]::Windows()) }
else {
  if($region.Width -le 0 -or $region.Height -le 0 -or ([long]$region.Width*$region.Height) -gt 24000000) { throw '截图范围无效或过大，请指定窗口' }
  $bitmap=New-Object System.Drawing.Bitmap($region.Width,$region.Height)
  $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
  $stream=New-Object System.IO.MemoryStream
  try {
    $graphics.CopyFromScreen($region.Location,[System.Drawing.Point]::Empty,$region.Size)
    $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
    if($stream.Length -gt 16777216){throw '截图超过 16 MiB，请指定窗口'}
    $result.image=[Convert]::ToBase64String($stream.ToArray())
    $result.capture=@{x=$region.X;y=$region.Y;width=$region.Width;height=$region.Height}
  } finally { $graphics.Dispose();$bitmap.Dispose();$stream.Dispose() }
}
$result | ConvertTo-Json -Depth 8 -Compress
`;
