package com.grash.model;

import com.grash.model.abstracts.CompanyAudit;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Binds an Offline Protocol SDK address (off1…) and its Ed25519 identity key to the Atlas user who registered it.
 */
@Entity
@Data
@NoArgsConstructor
public class OfflineDevice extends CompanyAudit {
    @ManyToOne
    @JoinColumn(nullable = false)
    private User user;

    @Column(nullable = false, unique = true, length = 128)
    private String address;

    /** Base64 of the 32 raw Ed25519 public key bytes. */
    @Column(nullable = false, length = 64)
    private String publicKey;
}
