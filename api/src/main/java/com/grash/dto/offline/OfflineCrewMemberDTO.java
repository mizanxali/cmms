package com.grash.dto.offline;

import lombok.AllArgsConstructor;
import lombok.Data;

@Data
@AllArgsConstructor
public class OfflineCrewMemberDTO {
    private Long userId;
    private String firstName;
    private String lastName;
    private String address;
    private String publicKey;
}
