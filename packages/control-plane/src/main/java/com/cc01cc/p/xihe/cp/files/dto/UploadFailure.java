package com.cc01cc.p.xihe.cp.files.dto;

public class UploadFailure {

    private String fileName;
    private String reason;

    public UploadFailure() {}

    public UploadFailure(String fileName, String reason) {
        this.fileName = fileName;
        this.reason = reason;
    }

    public String getFileName() { return fileName; }
    public void setFileName(String fileName) { this.fileName = fileName; }

    public String getReason() { return reason; }
    public void setReason(String reason) { this.reason = reason; }
}
