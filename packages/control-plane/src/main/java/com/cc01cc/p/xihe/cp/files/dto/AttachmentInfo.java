package com.cc01cc.p.xihe.cp.files.dto;

public class AttachmentInfo {

    private String id;
    private String name;
    private String type;
    private long size;
    private String url;

    public AttachmentInfo() {}

    public AttachmentInfo(String id, String name, String type, long size, String url) {
        this.id = id;
        this.name = name;
        this.type = type;
        this.size = size;
        this.url = url;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }

    public long getSize() { return size; }
    public void setSize(long size) { this.size = size; }

    public String getUrl() { return url; }
    public void setUrl(String url) { this.url = url; }
}
