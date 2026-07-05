package com.cc01cc.p.xihe.cp.files.dto;

import java.util.List;

public class BatchUploadResult {

    private List<AttachmentInfo> success;
    private List<UploadFailure> failed;

    public BatchUploadResult() {}

    public BatchUploadResult(List<AttachmentInfo> success, List<UploadFailure> failed) {
        this.success = success;
        this.failed = failed;
    }

    public List<AttachmentInfo> getSuccess() { return success; }
    public void setSuccess(List<AttachmentInfo> success) { this.success = success; }

    public List<UploadFailure> getFailed() { return failed; }
    public void setFailed(List<UploadFailure> failed) { this.failed = failed; }
}
