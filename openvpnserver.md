# openvpnserver.md — OpenVPN server setup on Issabel (Rocky 8)

Replicable server-side recipe. Proven on a live Issabel box (OpenVPN 2.4.12,
Easy-RSA 3.2.1). Topology: Issabel = VPN server on its public IP; remote
gateway (e.g. Yeastar TG400) = VPN client dialing in. Client gets fixed tunnel
IP `10.8.0.2`; server is `10.8.0.1`.

> Pitfalls this recipe already accounts for (learned the hard way):
> - OpenVPN 2.4 does NOT accept `openvpn --genkey secret FILE` (2.5+ syntax).
>   Use `openvpn --genkey --secret FILE`.
> - Easy-RSA 3.2.1 has NO `gen-tls` command. Don't look for it.
> - `openvpn-server@server` reads **`/etc/openvpn/server/server.conf`**
>   (instance folder), NOT `/etc/openvpn/server.conf`. Wrong place =
>   `Error opening configuration file: server.conf` + crash loop.
> - `client-config-dir` must exist or the service dies at startup.
> - The `no bc` warnings during cert creation are harmless cosmetics.

## 0. Install

```bash
dnf install -y epel-release
dnf install -y openvpn easy-rsa
```

## 1. PKI (one-time; back up `/etc/openvpn/easy-rsa/pki` — losing it means reissuing all clients)

```bash
mkdir -p /etc/openvpn/easy-rsa && cp -r /usr/share/easy-rsa/3/* /etc/openvpn/easy-rsa/
cd /etc/openvpn/easy-rsa
./easyrsa init-pki
./easyrsa build-ca nopass
# Common Name: pick something meaningful, e.g. the server hostname
./easyrsa build-server-full issabel-server nopass
# type 'yes' when asked to confirm details (valid 825 days, until ~Dec 2028)
./easyrsa build-client-full tg400 nopass
# 'tg400' = client cert name; MUST match the ccd filename in step 3.
# For another client, repeat with its name (e.g. build-client-full tg800).
./easyrsa gen-dh
```

Resulting files: `pki/ca.crt`, `pki/issued/issabel-server.crt`,
`pki/private/issabel-server.key`, `pki/issued/tg400.crt`,
`pki/private/tg400.key`, `pki/dh.pem`.

## 2. TLS-auth key (OpenVPN 2.4 syntax)

```bash
openvpn --genkey --secret /etc/openvpn/ta.key
ls -la /etc/openvpn/ta.key   # ~636 bytes
```

## 3. Server config — exact path matters

Create **`/etc/openvpn/server/server.conf`** (not `/etc/openvpn/server.conf`):

```ini
port 1194
proto udp
dev tun
ca /etc/openvpn/easy-rsa/pki/ca.crt
cert /etc/openvpn/easy-rsa/pki/issued/issabel-server.crt
key /etc/openvpn/easy-rsa/pki/private/issabel-server.key
dh /etc/openvpn/easy-rsa/pki/dh.pem
tls-auth /etc/openvpn/ta.key 0
server 10.8.0.0 255.255.255.0
client-config-dir /etc/openvpn/ccd
keepalive 10 60
persist-key
persist-tun
cipher AES-256-GCM
auth SHA256
user nobody
group nobody
status /var/log/openvpn-status.log
verb 3
```

Pin the client to its fixed tunnel IP — `/etc/openvpn/ccd/tg400`
(filename == client cert name):

```ini
ifconfig-push 10.8.0.2 10.8.0.1
```

```bash
mkdir -p /etc/openvpn/ccd
cat > /etc/openvpn/ccd/tg400 <<'EOF'
ifconfig-push 10.8.0.2 10.8.0.1
EOF
```

## 4. Kernel forwarding

```bash
echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-openvpn.conf && sysctl --system
```

## 5. Firewall — pick ONE

Check first: `iptables -L -n`. If firewalld is running, use Option A,
otherwise Option B.

**Option A — firewalld:**
```bash
systemctl enable --now firewalld
firewall-cmd --permanent --add-port=1194/udp
firewall-cmd --permanent --add-service=openvpn
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address="10.8.0.0/24" accept'
firewall-cmd --reload
```

**Option B — raw iptables (no firewalld):**
```bash
iptables -I INPUT -p udp --dport 1194 -j ACCEPT
iptables -I INPUT -i tun+ -j ACCEPT
iptables -I FORWARD -i tun+ -j ACCEPT
iptables -I FORWARD -o tun+ -j ACCEPT
iptables-save > /etc/sysconfig/iptables
```

## 6. Start + verify

```bash
systemctl enable --now openvpn-server@server
systemctl status openvpn-server@server --no-pager | head -12
ip addr show tun0                        # must show 10.8.0.1
cat /var/log/openvpn-status.log
```

Want: `Active: active (running)` + `tun0` up. Server side done — next is the
client `.ovpn` bundle (ca.crt + client crt/key + ta.key inline, remote =
server public IP, `key-direction 1`) uploaded on the gateway.

## 7. Troubleshooting (in order of likelihood)

| Symptom in `journalctl -u openvpn-server@server` | Cause | Fix |
|---|---|---|
| `Error opening configuration file: server.conf` | Conf in wrong place | Move to `/etc/openvpn/server/server.conf` |
| `Cannot open ... ta.key / ca.crt / ...` | Path typo in conf | `grep -E "tls-auth\|^ca \|^cert \|^key \|^dh " /etc/openvpn/server/server.conf`, `ls` each path |
| Error mentioning `client-config-dir` / ccd | Folder missing | `mkdir -p /etc/openvpn/ccd` + client file |
| Service flap-looping every 5s | Any fatal above | `systemctl stop openvpn-server@server` first, fix, then start |

## 8. Housekeeping

- Certs valid 825 days from creation (~Dec 2028 for the first build). Set a
  rotation reminder: re-run `build-server-full` / `build-client-full`,
  redistribute, restart.
- Monitor: alert if `openvpn-status.log` loses the client entry
  (tunnel down = trunk down).
- Adding another gateway later: `build-client-full <name>`, matching
  `/etc/openvpn/ccd/<name>` with the next free `10.8.0.x`. No server restart
  needed (client certs are read on connect).
