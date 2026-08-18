# bcsa win-typer: types text on Windows via SendInput with KEYEVENTF_UNICODE.
#
# WHY THIS EXISTS
# ---------------
# The obvious route -- nut-js keyboard.type() -- is unsafe on Windows. It ends
# up in libnut's typeString(), which resolves every character through
# VkKeyScan() and then presses whatever modifiers that lookup demands:
#
#     int modifiers = keyCode >> 8;          // high byte = required shift state
#     if (modifiers & 2) flags |= MOD_CONTROL;   // real Ctrl keydown
#     if (modifiers & 4) flags |= MOD_ALT;       // real Alt keydown
#
# Three consequences, all of which fire browser accelerators:
#   * libnut truncates the code point to 8 bits before the lookup, so U+2014
#     lands on VK 0x14, U+2019 on 0x19, and anything congruent to 0x54 on VK_T.
#   * VkKeyScan returns -1 for any character absent from the active layout,
#     which becomes modifiers 0xFF -- Ctrl AND Alt AND Shift together.
#   * AltGr characters on non-US layouts ({ } [ ] \ | @ ~) legitimately report
#     Ctrl+Alt, so ordinary source code presses Ctrl on every brace.
# Ctrl+T opens a tab, Ctrl+W closes one, and Ctrl+Shift switches the keyboard
# layout out from under the rest of the run.
#
# KEYEVENTF_UNICODE sidesteps all of it: the code unit travels in wScan with
# wVk = 0, no layout lookup happens, and no modifier is ever pressed. This is
# the same mechanism password managers use to type into arbitrary windows.
#
# PROTOCOL (stdin, one command per line; each acked with "K" on stdout)
#   U <hex> [<hex>...]   type these UTF-16 code units (a pair = one astral char)
#   D <hex vk>           virtual-key down
#   P <hex vk>           virtual-key up
#   T <hex vk>           virtual-key down+up
# Prints "READY" once the P/Invoke type is compiled.

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class BcsaInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }
    // The union must carry MOUSEINPUT too, even though we never send mouse
    // events. SendInput rejects the call unless cbSize matches the real INPUT
    // size, and MOUSEINPUT is the largest member: 20 bytes of DWORDs, then
    // ULONG_PTR dwExtraInfo aligned to 8, so 32 on x64 and 24 on x86. INPUT is
    // that union after a DWORD type field, padded to the union's alignment --
    // 40 bytes on x64, 28 on x86, which is what SendInput expects. Declaring
    // the union with KEYBDINPUT alone would compute 32 on x64 and every call
    // would fail. This mirrors InputSimulator's MOUSEKEYBDHARDWAREINPUT.
    // HARDWAREINPUT is omitted only because it is smaller than MOUSEINPUT and
    // so cannot affect the size.
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    const uint INPUT_KEYBOARD   = 1;
    const uint KEYEVENTF_KEYUP  = 0x0002;
    const uint KEYEVENTF_UNICODE= 0x0004;
    const uint KEYEVENTF_SCANCODE = 0x0008;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern uint MapVirtualKey(uint uCode, uint uMapType);

    static INPUT Key(ushort vk, ushort scan, uint flags) {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk; i.u.ki.wScan = scan;
        i.u.ki.dwFlags = flags; i.u.ki.time = 0; i.u.ki.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    static void Send(INPUT[] inputs) {
        if (inputs.Length == 0) return;
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length)
            throw new Exception("SendInput sent " + sent + " of " + inputs.Length +
                                " (err " + Marshal.GetLastWin32Error() + ")");
    }

    // One character, as 1 or 2 UTF-16 code units. Both units of a surrogate
    // pair go down before either comes up, or the target sees two broken halves
    // rather than one astral character.
    //
    // Per the KEYBDINPUT docs, KEYEVENTF_UNICODE requires wVk = 0, carries the
    // character in wScan, and "can only be combined with the KEYEVENTF_KEYUP
    // flag" -- so no KEYEVENTF_SCANCODE here, unlike KeyEvent below.
    public static void TypeUnits(ushort[] units) {
        INPUT[] inputs = new INPUT[units.Length * 2];
        for (int i = 0; i < units.Length; i++)
            inputs[i] = Key(0, units[i], KEYEVENTF_UNICODE);
        for (int i = 0; i < units.Length; i++)
            inputs[units.Length + i] = Key(0, units[i], KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
        Send(inputs);
    }

    static bool IsExtended(ushort vk) {
        switch (vk) {
            case 0x24: case 0x23: case 0x25: case 0x26: case 0x27: case 0x28:
            case 0x21: case 0x22: case 0x2D: case 0x2E: case 0xA3: case 0xA5:
            case 0x5B: case 0x5C: return true;
            default: return false;
        }
    }

    // Virtual keys go out as scancodes so they survive targets that read the
    // hardware scancode (games, terminals, remote-desktop clients) rather than
    // the virtual key.
    public static void KeyEvent(ushort vk, bool down) {
        ushort scan = (ushort)MapVirtualKey(vk, 0);
        uint flags = KEYEVENTF_SCANCODE | (down ? 0u : KEYEVENTF_KEYUP);
        if (IsExtended(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
        Send(new INPUT[] { Key(vk, scan, flags) });
    }
}
'@

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    try {
        $parts = $line.Split(' ')
        switch ($parts[0]) {
            'U' {
                $units = New-Object 'System.UInt16[]' -ArgumentList ($parts.Length - 1)
                for ($i = 1; $i -lt $parts.Length; $i++) {
                    $units[$i - 1] = [Convert]::ToUInt16($parts[$i], 16)
                }
                [BcsaInput]::TypeUnits($units)
            }
            'D' { [BcsaInput]::KeyEvent([Convert]::ToUInt16($parts[1], 16), $true) }
            'P' { [BcsaInput]::KeyEvent([Convert]::ToUInt16($parts[1], 16), $false) }
            'T' {
                $vk = [Convert]::ToUInt16($parts[1], 16)
                [BcsaInput]::KeyEvent($vk, $true)
                [BcsaInput]::KeyEvent($vk, $false)
            }
            default { }
        }
        [Console]::Out.WriteLine('K')
    } catch {
        # Report and keep going: one bad character must not end the run, and the
        # caller is waiting on an ack it would otherwise never receive.
        [Console]::Out.WriteLine('E ' + $_.Exception.Message.Replace("`n", ' '))
    }
    [Console]::Out.Flush()
}
