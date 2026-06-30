package com.cc01cc.p.xihe.cp.telemetry;

import java.util.List;

public class TelemetryEntry {
    private long timestamp;
    private String level;
    private String message;
    private Object data;

    public long getTimestamp() { return timestamp; }
    public void setTimestamp(long timestamp) { this.timestamp = timestamp; }
    public String getLevel() { return level; }
    public void setLevel(String level) { this.level = level; }
    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }
    public Object getData() { return data; }
    public void setData(Object data) { this.data = data; }

    public static class BatchRequest {
        private String device_id;
        private List<TelemetryEntry> entries;

        public String getDevice_id() { return device_id; }
        public void setDevice_id(String device_id) { this.device_id = device_id; }
        public List<TelemetryEntry> getEntries() { return entries; }
        public void setEntries(List<TelemetryEntry> entries) { this.entries = entries; }
    }
}
