terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    bigip = {
      source  = "F5Networks/bigip"
      version = "~> 1.22"
    }
  }
}

provider "bigip" {
  address  = var.bigip_address
  username = var.bigip_username
  password = var.bigip_password
}
