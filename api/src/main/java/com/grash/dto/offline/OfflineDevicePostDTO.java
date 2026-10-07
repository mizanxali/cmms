package com.grash.dto.offline;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class OfflineDevicePostDTO {
    @NotBlank
    @Size(max = 128)
    private String address;
    @NotBlank
    private String publicKey;
}
