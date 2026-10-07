package com.grash.dto.offline;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/** The serialized op body and its base64 Ed25519 signature. */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class OfflineEnvelopeDTO {
    private String body;
    private String sig;
}
