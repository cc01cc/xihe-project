package com.cc01cc.p.xihe.cp.telemetry;

import java.util.List;

public class TelemetryEntry {
    private long timestamp;
    private String level;
    private String message;
    private Object data;
    private String eventId;
    private String eventType;
    private String errorCode;
    private String appVersion;

    public long getTimestamp() { return timestamp; }
    public void setTimestamp(long timestamp) { this.timestamp = timestamp; }
    public String getLevel() { return level; }
    public void setLevel(String level) { this.level = level; }
    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }
    public Object getData() { return data; }
    public void setData(Object data) { this.data = data; }
    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }
    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public String getAppVersion() { return appVersion; }
    public void setAppVersion(String appVersion) { this.appVersion = appVersion; }

    public static class BatchRequest {
        private String batchId;
        private String deviceId;
        private List<TelemetryEntry> entries;

        public String getBatchId() { return batchId; }
        public void setBatchId(String batchId) { this.batchId = batchId; }
        public String getDeviceId() { return deviceId; }
        public void setDeviceId(String deviceId) { this.deviceId = deviceId; }
        public List<TelemetryEntry> getEntries() { return entries; }
        public void setEntries(List<TelemetryEntry> entries) { this.entries = entries; }
    }
}
