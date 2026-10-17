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
    private String serviceVersion;
    private String releaseChannel;
    private String osFamily;
    private String browserFamily;
    private String lang;
    private String screenBucket;
    private String anonSessionId;

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
    public String getServiceVersion() { return serviceVersion; }
    public void setServiceVersion(String serviceVersion) { this.serviceVersion = serviceVersion; }
    public String getReleaseChannel() { return releaseChannel; }
    public void setReleaseChannel(String releaseChannel) { this.releaseChannel = releaseChannel; }
    public String getOsFamily() { return osFamily; }
    public void setOsFamily(String osFamily) { this.osFamily = osFamily; }
    public String getBrowserFamily() { return browserFamily; }
    public void setBrowserFamily(String browserFamily) { this.browserFamily = browserFamily; }
    public String getLang() { return lang; }
    public void setLang(String lang) { this.lang = lang; }
    public String getScreenBucket() { return screenBucket; }
    public void setScreenBucket(String screenBucket) { this.screenBucket = screenBucket; }
    public String getAnonSessionId() { return anonSessionId; }
    public void setAnonSessionId(String anonSessionId) { this.anonSessionId = anonSessionId; }

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
