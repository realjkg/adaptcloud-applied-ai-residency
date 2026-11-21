variable "bigip_address" {
  type        = string
  description = "Management address of the BIG-IP."
}

variable "bigip_username" {
  type      = string
  sensitive = true
}

variable "bigip_password" {
  type      = string
  sensitive = true
}

variable "certificate_pem" {
  type        = string
  sensitive   = true
  description = "Certificate chain, supplied at run time from the secret store."
}

variable "private_key_pem" {
  type        = string
  sensitive   = true
  description = "Private key, supplied at run time from the secret store. Never committed."
}
