# Database certificates

Put the certificate files of your database here when it needs them. The backend sees this folder
as `/certs`, so in `deploy/.env` you would set, for example:

```
DATABASE_SSL_CA=/certs/server-ca.pem         # the server's CA: the backend checks the database
DATABASE_SSL_CERT=/certs/client-cert.pem     # only if the database requires client certificates
DATABASE_SSL_KEY=/certs/client-key.pem
```

The backend runs as user 1001 inside the container, so let it read the files:

```bash
sudo chown 1001:1001 *.pem && sudo chmod 600 *.pem
```

Everything except this README is ignored by git; never commit keys.
