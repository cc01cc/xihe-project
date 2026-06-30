package com.cc01cc.p.xihe.cp.log;

import java.util.List;

public class LogEntry {
    private String level;
    private String message;
    private String timestamp;

    public String getLevel() { return level; }
    public void setLevel(String level) { this.level = level; }
    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }
    public String getTimestamp() { return timestamp; }
    public void setTimestamp(String timestamp) { this.timestamp = timestamp; }

    public static class BatchRequest {
        private List<LogEntry> entries;
        public List<LogEntry> getEntries() { return entries; }
        public void setEntries(List<LogEntry> entries) { this.entries = entries; }
    }
}
