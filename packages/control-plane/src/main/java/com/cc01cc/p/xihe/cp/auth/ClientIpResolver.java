package com.cc01cc.p.xihe.cp.auth;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/**
 * PLAN-0558: resolves the client IP used for login throttling.
 *
 * <p>X-Forwarded-For is ignored unless the socket remote address is in the
 * configured trusted proxy list. A trusted proxy's XFF chain is read right to
 * left and the first non-trusted literal is used. No DNS lookup is performed;
 * only strict IP literals are accepted.</p>
 */
@Component
public class ClientIpResolver {

    private static final Logger logger = LoggerFactory.getLogger(ClientIpResolver.class);
    private static final Pattern IPV4 = Pattern.compile("^(\\d{1,3}\\.){3}\\d{1,3}$");
    private static final Pattern IPV6 = Pattern.compile("^[0-9a-fA-F:.]+$");

    private final List<Cidr> trustedProxies;
    private final int ipv6PrefixLength;

    public ClientIpResolver(
            @Value("${cp.auth.login.trusted-proxies:}") String trustedProxies,
            @Value("${cp.auth.login.ipv6-prefix-length:64}") int ipv6PrefixLength) {
        this.trustedProxies = parseTrusted(trustedProxies);
        this.ipv6PrefixLength = ipv6PrefixLength < 0 || ipv6PrefixLength > 128
                ? 64 : ipv6PrefixLength;
    }

    /** Returns a stable, normalized bucket key; never throws. */
    public String resolve(HttpServletRequest request) {
        return bucketKey(clientLiteral(request));
    }

    /**
     * PLAN-0571: the raw client literal (before IPv6 /64 aggregation) paired
     * with its bucket key. Register throttling must exempt loopback by the
     * raw address: masking ::1 into the unspecified :: hides its loopback
     * nature and defeats the register.exempt-loopback knob.
     */
    public ResolvedClientIp resolveClientIp(HttpServletRequest request) {
        String literal = clientLiteral(request);
        return new ResolvedClientIp(literal, bucketKey(literal));
    }

    public record ResolvedClientIp(String raw, String bucketKey) {
    }

    /** First non-trusted XFF literal (trusted proxy chains) or the remote address. */
    private String clientLiteral(HttpServletRequest request) {
        String remote = normalize(request.getRemoteAddr());
        if (remote == null) {
            return "unknown";
        }
        if (!isTrusted(remote)) {
            return remote;
        }
        List<String> forwarded = new ArrayList<>();
        for (String header : Collections.list(request.getHeaders("X-Forwarded-For"))) {
            if (header == null) {
                continue;
            }
            for (String part : header.split(",")) {
                String candidate = normalize(part);
                if (candidate != null) {
                    forwarded.add(candidate);
                }
            }
        }
        for (int i = forwarded.size() - 1; i >= 0; i--) {
            String candidate = forwarded.get(i);
            if (!isTrusted(candidate)) {
                return candidate;
            }
        }
        return remote;
    }

    static String normalize(String value) {
        if (value == null) {
            return null;
        }
        String candidate = value.trim();
        if (candidate.isEmpty()) {
            return null;
        }
        if (candidate.startsWith("[") && candidate.endsWith("]")) {
            candidate = candidate.substring(1, candidate.length() - 1);
        }
        if (candidate.indexOf('%') >= 0) {
            return null;
        }
        if (IPV4.matcher(candidate).matches()) {
            String[] parts = candidate.split("\\.");
            for (String part : parts) {
                int octet = Integer.parseInt(part);
                if (octet > 255) {
                    return null;
                }
            }
            return hostAddress(candidate);
        }
        boolean looksLikeIpv6 = IPV6.matcher(candidate).matches()
                && candidate.indexOf(':') >= 0
                && (candidate.contains("::") || countColons(candidate) >= 2);
        return looksLikeIpv6 ? hostAddress(candidate) : null;
    }

    private String bucketKey(String ip) {
        byte[] bytes = toBytes(ip);
        if (bytes == null || bytes.length != 16 || ipv6PrefixLength >= 128) {
            return ip;
        }
        int prefix = ipv6PrefixLength;
        byte[] masked = bytes.clone();
        for (int i = 0; i < masked.length; i++) {
            int keep = Math.max(0, Math.min(8, prefix - i * 8));
            if (keep == 0) {
                masked[i] = 0;
            } else if (keep < 8) {
                masked[i] = (byte) (masked[i] & (0xFF << (8 - keep)));
            }
        }
        try {
            return InetAddress.getByAddress(masked).getHostAddress();
        } catch (UnknownHostException e) {
            return ip;
        }
    }

    private boolean isTrusted(String ip) {
        byte[] address = toBytes(ip);
        if (address == null) {
            return false;
        }
        for (Cidr cidr : trustedProxies) {
            if (cidr.matches(address)) {
                return true;
            }
        }
        return false;
    }

    private static List<Cidr> parseTrusted(String raw) {
        List<Cidr> result = new ArrayList<>();
        if (raw == null || raw.isBlank()) {
            return result;
        }
        for (String entry : raw.split(",")) {
            String candidate = entry.trim();
            if (candidate.isEmpty()) {
                continue;
            }
            Cidr cidr = parseCidr(candidate);
            if (cidr == null) {
                logger.warn("Ignoring invalid trusted proxy entry: {}", candidate);
            } else {
                result.add(cidr);
            }
        }
        return result;
    }

    private static Cidr parseCidr(String value) {
        int slash = value.indexOf('/');
        String ipPart = slash >= 0 ? value.substring(0, slash) : value;
        String prefixPart = slash >= 0 ? value.substring(slash + 1) : null;
        String ip = normalize(ipPart);
        byte[] bytes = toBytes(ip);
        if (bytes == null) {
            return null;
        }
        int maxPrefix = bytes.length * 8;
        int prefix;
        try {
            prefix = prefixPart == null ? maxPrefix : Integer.parseInt(prefixPart);
        } catch (NumberFormatException e) {
            return null;
        }
        if (prefix < 0 || prefix > maxPrefix) {
            return null;
        }
        return new Cidr(bytes, prefix);
    }

    private static byte[] toBytes(String ip) {
        if (ip == null) {
            return null;
        }
        try {
            return InetAddress.getByName(ip).getAddress();
        } catch (UnknownHostException e) {
            return null;
        }
    }

    private static String hostAddress(String literal) {
        try {
            return InetAddress.getByName(literal).getHostAddress();
        } catch (UnknownHostException e) {
            return null;
        }
    }

    private static int countColons(String value) {
        int count = 0;
        for (int i = 0; i < value.length(); i++) {
            if (value.charAt(i) == ':') {
                count++;
            }
        }
        return count;
    }

    private record Cidr(byte[] network, int prefix) {

        boolean matches(byte[] address) {
            if (address.length != network.length) {
                return false;
            }
            int fullBytes = prefix / 8;
            int remaining = prefix % 8;
            for (int i = 0; i < fullBytes; i++) {
                if (address[i] != network[i]) {
                    return false;
                }
            }
            if (remaining == 0) {
                return true;
            }
            int mask = 0xFF << (8 - remaining);
            return (address[fullBytes] & mask) == (network[fullBytes] & mask);
        }
    }
}
