package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

import java.util.UUID;

/**
 * Maps PostgreSQL native UUID columns to Java String attributes.
 *
 * PLAN-280: the canonical schema stores ids as UUID; the application layer
 * keeps String ids (API/JSON/SSE already exchange UUID strings), so this
 * converter owns the boundary conversion instead of churning ~100 files to
 * java.util.UUID.
 */
@Converter
public class UuidStringConverter implements AttributeConverter<String, UUID> {

    @Override
    public UUID convertToDatabaseColumn(String attribute) {
        return attribute == null || attribute.isBlank() ? null : UUID.fromString(attribute);
    }

    @Override
    public String convertToEntityAttribute(UUID dbData) {
        return dbData == null ? null : dbData.toString();
    }
}
