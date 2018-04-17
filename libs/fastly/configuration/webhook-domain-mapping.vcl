table host_backends_map {
  "perpetualhappiness.com": "0001.test.risd.systems",
  "test.risd.systems": "0001.test.risd.systems"
}


sub vcl_recv {
#FASTLY recv

  if (req.request != "HEAD" && req.request != "GET" && req.request != "FASTLYPURGE") {
    return(pass);
  }

  # aSnippet backend_mapping : 110
  if ( table.lookup( host_backends_map, req.http.host ) ) {
    set req.http.requseted-host = req.http.host;
    set req.http.host = table.lookup( host_backends_map, req.http.host );
  }

  return(lookup);
}

sub vcl_fetch {
#FASTLY fetch

  # aSnippet restore_original_host: 110
  if ( req.http.requseted-host ) {
    set req.http.host = req.http.requseted-host;
  }

  if ((beresp.status == 500 || beresp.status == 503) && req.restarts < 1 && (req.request == "GET" || req.request == "HEAD")) {
    restart;
  }

  if (req.restarts > 0) {
    set beresp.http.Fastly-Restarts = req.restarts;
  }

  if (beresp.http.Set-Cookie) {
    set req.http.Fastly-Cachetype = "SETCOOKIE";
    return(pass);
  }

  if (beresp.http.Cache-Control ~ "private") {
    set req.http.Fastly-Cachetype = "PRIVATE";
    return(pass);
  }

  if (beresp.status == 500 || beresp.status == 503) {
    set req.http.Fastly-Cachetype = "ERROR";
    set beresp.ttl = 1s;
    set beresp.grace = 5s;
    return(deliver);
  }

  if (beresp.http.Expires || beresp.http.Surrogate-Control ~ "max-age" || beresp.http.Cache-Control ~ "(s-maxage|max-age)") {
    # keep the ttl here
  } else {
    # apply the default ttl
    set beresp.ttl = 3600s;
  }

  return(deliver);
}

sub vcl_hit {
#FASTLY hit

  if (!obj.cacheable) {
    return(pass);
  }
  return(deliver);
}

sub vcl_miss {
#FASTLY miss
  return(fetch);
}

sub vcl_deliver {
#FASTLY deliver
  return(deliver);
}

sub vcl_error {
#FASTLY error

  # aSnippet error_redirect_synthetic : 100
  if (obj.status == 301 && req.http.x-redirect-location) {
    set obj.http.Location = req.http.x-redirect-location;
    set obj.response = "Found";
    synthetic {""};
    return(deliver);
  }
}

sub vcl_pass {
#FASTLY pass
}

sub vcl_log {
#FASTLY log
}