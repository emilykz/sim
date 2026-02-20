tell application "System Events"
  tell process "Simulator"
    set outText to ""
    repeat with i from 1 to (count of windows)
      set w to window i
      set t to ""
      try
        set t to name of w
      end try
      set p to position of w
      set s to size of w
      set outText to outText & i & ": title='" & t & "' pos=" & (item 1 of p) & "," & (item 2 of p) & " size=" & (item 1 of s) & "x" & (item 2 of s) & linefeed
    end repeat

    -- Try to find the correct window by title
    repeat with i from 1 to (count of windows)
      set w to window i
      set t to ""
      try
        set t to name of w
      end try
      if t contains "iPhone 16 Pro" then
        set p to position of w
        set s to size of w
        return outText & linefeed & "MATCH: " & i & ": title='" & t & "' pos=" & (item 1 of p) & "," & (item 2 of p) & " size=" & (item 1 of s) & "x" & (item 2 of s)
      end if
    end repeat

    return outText & linefeed & "MATCH: none (no window title contained 'iPhone 16 Pro')"
  end tell
end tell
